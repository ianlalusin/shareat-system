# T-134 — The cutover wizard: a guided, verified 31 December

> **Status:** ⚠️ **PROVISIONAL — written BEFORE the research pass, which is backwards.**
> Bible §3.6 requires research first for a new feature of any size, and Ian had to point that out.
> `docs/discovery/21-migration-wizards.md` is being written now; **this document is a first draft
> to be corrected against it, not a decision.** Anything below may change.
> **Runs at least twice:** the **November rehearsal** (ADR-007) and the real cutover.
> **Depends on:** T-119 (the purge), T-121 (roles), and the opening-balance entry.

## What it is — and what it deliberately is not

Ian: *"A multi-step guide for any manager — what to delete, prompt 'delete these test data'; what
to add, show the user what is needed; a progress bar so nothing is missed."*

**It is a checklist that VERIFIES, not a button that automates.** Several steps happen outside the
software entirely — a physical stock count, a walk-round of the assets — and no wizard can perform
those. What it can do is refuse to let the cutover proceed as though they had happened.

> **⭐ The design principle: a step is complete when the SYSTEM can see it is complete, not when
> someone ticked a box.** A checkbox proves that a person clicked. Every guard in this project
> exists because a control that only looks real is worse than none — DEF-051, DEF-052, Dolibarr's
> unchecked credit limit. **The wizard is that lesson applied to a procedure instead of a
> permission.**

## Three kinds of step, and the difference is shown on screen

| | How it completes | Example |
|---|---|---|
| ✅ **Verified** | A query proves it. **Cannot be ticked by hand** | *"3900 nets to zero"* · *"every purge-class table is empty"* |
| ✍️ **Attested** | A named person states it, with a timestamp and their name recorded | *"I counted Lipa's stock on 31 Dec"* |
| ⚙️ **Performed** | The wizard runs it and records the result | The purge · the opening-balance posting |

**Attested steps are visibly weaker on screen and say so.** *"Recorded by Ian, 31 Dec 22:14 — not
machine-verifiable"* is honest; a green tick that looks identical to a verified one is not.

---

## The steps, in enforced order

**A step is not startable until its prerequisites VERIFY.** That ordering is the whole value —
"so nothing is missed" is really "so nothing is done in the wrong order", and the two failures
that would actually hurt are both ordering failures.

### Phase A — in v1, during December

| # | Step | Kind | Why it is first |
|---|---|---|---|
| A1 | **Clear the delivery-expensing backlog** | ✅ verified — *no delivery in the period lacks a linked expense* | **The cost basis is weakest for exactly the stock being valued** (ADR-009). Counting first produces quantities with no cost |
| A2 | **Final v1 depreciation run** | ✅ verified — *depreciation legs exist for the last period* | It lands directly in the opening balance. DEF-044 showed it silently stops |
| A3 | **Export May–Dec figures** | ✍️ attested | Feeds Ian's 2026 spreadsheet (ADR-005) |

### Phase B — the physical work, 31 December

| # | Step | Kind | |
|---|---|---|---|
| B1 | **Valued stock count, per store** | ✍️ attested **per store** | Four separate attestations, not one. A single tick would hide a store nobody visited |
| B2 | **Asset walk-round** | ✍️ attested per store | Confirms existence and **remaining useful life** — the field without which v2 cannot depreciate anything (row 109) |
| B3 | **Enter counted quantities** | ✅ verified — *every active item has an opening quantity, or an explicit zero* | **An item silently absent is indistinguishable from an item counted as zero.** The wizard must force the distinction |

### Phase C — the switch, 1 January

| # | Step | Kind | |
|---|---|---|---|
| C1 | **Backup taken and restore REHEARSED** | ✍️ attested + ✅ verified *(a restore actually ran)* | Bible §15.8. *"A backup was taken"* is not the claim that matters |
| C2 | **Run the purge** | ⚙️ performed — `cutover:purge` | Dry-run first, always. Post-conditions assert inside the transaction (T-119) |
| C3 | **Enter opening balances** | ✅ verified per section | See below — the wizard tells you what is missing |
| C4 | **3900 nets to exactly zero** | ✅ verified | **A residual HALTS.** Never plugged (ADR-005, research §7.2) |
| C5 | **Trial balance ties** | ✅ verified | The books are open |

---

## "Show the user what is needed" — derived, never a static list

The opening-balance step does **not** present a form and hope. It computes what is outstanding
from what the system already knows, and shows the gap:

- **AR / AP:** every party carrying a balance in the v1 audit that has **no opening figure yet** —
  listed by name, with the audited figure beside the entered one.
- **Cash and bank:** every account of type cash/bank with no opening entry.
- **Assets:** every asset from the walk-round with no opening book value **or no remaining life**.
- **Inventory:** every counted item with a quantity but no cost basis.

> **This is the difference between a checklist and a guide.** A checklist says *"enter opening
> AR."* A guide says *"14 suppliers still have no opening figure — here they are, and here is what
> the audit says each should be."*

The audited figures come from `docs/reviews/v1-audit-*.md`, which already produces per-party
totals. **The wizard shows them as a reference, never as a default** — a pre-filled figure gets
accepted without being checked, and the whole point of the count is that someone checks.

## Progress

`n of m verified` overall, and per phase. **Blocked steps are shown as blocked with the reason**,
not hidden — *"B3 waits on B1: Malvar has no count attestation"* tells you what to go and do.

**Resumable across weeks.** The cutover spans December into January; state persists, and anyone
opening the wizard sees exactly where it stands and who did what.

## Rehearsal mode

ADR-007 requires the purge to be rehearsed in November against a restored copy. **The wizard runs
in rehearsal mode against that copy** — identical steps, all writes confined to the restored
database, and every attestation marked `REHEARSAL` so it can never be mistaken for the real one.

**The rehearsal is where the wizard earns its keep**: it is the run that finds the step nobody
thought of, at a point when that discovery is free.

## Who may run it

`run_cutover` — a **new capability**, and one nobody holds by default. Per the matrix's own rule
it needs a test proving the denial fires.

- **Attestations** may be recorded by a **manager**, per store, and are stamped with their name.
- **The purge and the opening entry** are **admin**. C2 and C3 are irreversible in practice.

## Open

1. **Does a manager see the whole wizard, or only their store's steps?** Suggested: the whole
   thing, read-only, with their own store's attestations editable. Seeing the progress is part of
   what stops a store being forgotten.
2. **What happens if the count finds a variance against the computed value?** Suggested: record
   both and require a reason above a threshold — the variance IS the finding (ADR-009), so
   silently overwriting the computed figure throws away the control the count exists to provide.
3. **Should C3 accept partial entry across days?** Almost certainly yes — 14 suppliers will not be
   entered in one sitting.
