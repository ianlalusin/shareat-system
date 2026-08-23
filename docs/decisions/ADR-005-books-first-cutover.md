# ADR-005 — Books-first cutover, 1 January 2027

| | |
|---|---|
| **Status** | Accepted 2026-08-23 |
| **Decided by** | Ian — date, close-in-the-old-system rationale, and the Oct/Nov/Dec/Jan shape |
| **Follows** | ADR-003 (one backend), ADR-004 (monorepo). Implements bible §10 Phase 8 |

## Context

Ian set the shape: **build and test through October and November, clean the data in December,
onboard in January.** And the reason for January, which is better than the one I gave:
**close the 2026 books in the old system, adjustments and all, then hand over a settled
number.**

That reason is the strongest argument in this ADR. Year-end close is iterative — accruals,
depreciation, count adjustments, reclassifications. Doing it in the old system means the new
one never inherits half-finished adjustment noise. The opening balance stops being a snapshot
of a moving target and becomes **one dated, signed-off artifact**.

### The constraint that forces a scope decision

There are eight phases. Phase 1 is two tasks in. Full parity across Phases 1–7 by 30 November
is not achievable: v1 carries 144 server-action modules and ~54k LOC of pages, and inventory
valuation, attendance/biometrics/offline, and payroll are each multi-week efforts on their own.

Pretending otherwise would mean the modules that land last — payroll and inventory — ship with
the least confidence. **Those are exactly the modules where wrong numbers hurt people.**

## Decision

**Cut over the BOOKS on 2027-01-01. Everything else follows through Q1 behind feature flags.**

### In scope for 1 January

| Phase | Delivers |
|---|---|
| **1** | The accounting spine — chart of accounts, journal, posting engine, reversal, fiscal periods, the ten invariants |
| **2** | Money-moving source documents — expenses, AP, AR, payments, cash requests, sales day, settlements |
| **6 (subset)** | Trial balance · P&L · balance sheet · AR and AP aging. Enough to *run* the books, not the full dashboard suite |

### Explicitly NOT in scope for 1 January

**Inventory (Phase 3) · Attendance (Phase 4) · Payroll (Phase 5) · full reporting (Phase 6) ·
peripheral modules (Phase 7) · POSv2 · CUSTOMERv2 · Website.**

These stay in the existing systems and cross over during Q1, one at a time, behind feature
flags. This is the strangler fig already decided in bible §13 row 20 — not a change of plan.

## The opening balance

**One artifact: the closed, adjusted trial balance as at 2026-12-31**, produced by the old ERP
after its own year-end close.

- **Balance sheet accounts only.** No historical detail load.
- Loaded as **one journal entry**, dated 2027-01-01, balancing to **3900 Opening balance
  equity**.
- **3900 must net to zero** once loaded and reconciled. A residual balance means the migration
  did not balance — that is the check, not a formality.

### Why the balance sheet alone is enough — and honest

Discovery found the legacy ERP is **wrong about the P&L and broadly right about the balance
sheet**. It has no nominal ledger (DEF-006), so revenue and expense never post as journal legs
— but it *does* post the cash, AP, AR and online sides correctly.

A cutover on an opening balance needs **only** the balance sheet. So this inherits the half v1
gets right and leaves the broken half behind. That is not a compromise; it is the correct use
of what actually exists.

**Consequence, accepted with open eyes: 2027 is year one of trustworthy P&L.** Any 2026
comparative comes from a hand-maintained scan list, not a ledger. Such figures are labelled
**"legacy basis, unaudited"** and are **never loaded as if they were real comparatives**.
Loading known-bad numbers as a baseline would quietly undermine the whole point.

## Temporary bridges — named, and each with a retirement trigger

**The integration layer does not all die in January.** ADR-003 deletes it when the apps are
rebuilt onto one backend; until each front-end is rebuilt, a bridge is required. Being explicit
about this now prevents a later reader concluding ADR-003 was violated.

| Bridge | Direction | Mechanism | Retires when |
|---|---|---|---|
| **Sales** | POS → ledger | The existing daily feed, recorded as a sales-day source document. **Survives the cutover** — POSv2 is far out | POSv2 ships |
| **Payroll** | v1 → ledger | **Monthly summary journal entry**, keyed from the v1 payroll register | Phase 5 ships |
| **Inventory** | v1 → ledger | **Monthly summary journal entry** — valuation movement and COGS | Phase 3 ships |
| **Attendance** | v1 → v1 payroll | No direct GL effect | Phase 4 ships |

**Summary entries are manual, monthly, and idempotent** — keyed by period so a re-run cannot
double-post. Deliberately low-tech: an automated feed would be a new integration built to be
thrown away, and would risk the dual-write bible §15.4 forbids. **v1 remains the sole writer of
payroll and inventory data**; v2's ledger merely receives a summary posting.

Each summary entry cites a **real source document** — the v1 payroll register or inventory
valuation report, archived as a file — satisfying invariant 4 (every posting traces to a source
document). "System-generated" is not an acceptable source.

## Calendar

| When | What |
|---|---|
| **Aug – Nov** | Build and test Phases 1, 2, and the Phase 6 subset |
| **30 Sep** | **Full backup + ETL Stage 1 dry run.** Rehearse the *restore*, not just the backup |
| **Oct – Dec** | Stage 1 runs repeatedly in analysis mode. **Its imbalance findings feed Ian's 2026 close** |
| **December** | Data cleanup. Old ERP closes 2026 with all year-end adjustments |
| **December** | **Reconciled dual-run** — both systems produce the same numbers for a period. This is Phase 8's exit gate |
| **1 Jan 2027** | Books cutover. Opening balance loaded. Onboarding |
| **Q1 2027** | Inventory, attendance, payroll, then the front-ends — one at a time |

### The September dry run earns its keep twice

Stage 1 loads nothing. It reads all of v1's journal and tries to balance every entry through
the nominal-leg mapping (T-113), classifying each as balanced, ambiguous, or genuinely
imbalanced.

**That report is an input to the 2026 close.** Imbalances are found mechanically, fixed in the
old system as part of year-end, and the trial balance handed over in January is cleaner as a
result. Bible §1.4 already says the migration *is* the audit and that findings should be shared
back rather than resolved only inside v2 — this makes that operational.

## Honesty checkpoints

A date is only real if there is a defined moment to admit it is slipping. **Ian is told at the
checkpoint, not in December.**

| Checkpoint | Test | If it fails |
|---|---|---|
| **30 Sep** | Phase 1 complete — invariants green, trial balance ties, ETL Stage 1 produces a report | Phase 2 will not fit. Cut the Phase 6 subset first |
| **31 Oct** | Phase 2 at least half done — expenses and AP posting into the spine | Escalate. Either narrow January to expenses+AP only, or move the date |
| **15 Nov** | **Go / no-go.** Phase 2 feature-complete and under test | No-go means moving to 1 April 2027 — the next clean quarter boundary — not shipping a half-built ledger |

**Moving the date is preferable to shipping books that cannot be trusted.** The entire premise
of this project is correct accounting; missing a date costs weeks, and wrong books cost
confidence in every number thereafter.

## Consequences

**Accepted:**
- Two systems run in parallel through Q1, with one writer per module and no dual-write.
- The POS→ledger seam survives until POSv2, longer than ADR-003's end state implies.
- 2026 comparatives are legacy-basis and unaudited.
- Manual monthly summary entries are operational overhead until Phases 3 and 5 land.

**Gained:**
- 2027 opens with a correct, verifiable ledger and a signed-off opening balance.
- The riskiest modules get the *most* build time, not the least.
- The old system's final close is used as designed, rather than being cut off mid-year.
- January 1 is a clean fiscal boundary: pure balance-sheet opening balance, no YTD carry, no
  split-year comparatives.
