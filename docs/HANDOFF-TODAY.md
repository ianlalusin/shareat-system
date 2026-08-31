# Handoff — 2026-08-31

## Where things stand

**Phase 5 (payroll) opened, and the first slice shipped: this business now has a payslip.** T-189
computes pay from `attendance_days`, nets what a person already drew against `1230`, posts
`Dr 6100 / Cr 1230 / Cr cash`, and freezes the days it paid. Four follow-ups the same day made
every premium and every date a per-store setting.

Before that, the three lanes were consolidated into one `main` (attendance, inventory, T-137), and
**T-186** (till custody) and **T-188** (supplier master) shipped.

⚠️ **Statutory contributions and withholding are NOT built, and the blocker is data, not effort** —
see "Do not decide these alone".

## Gates at `2ca399e`

```
typecheck  ✅ 0 errors
unit       ✅ 856 passed, 1 skipped (857)
integration ✅ 1731 passed (1731)
build      ✅ clean
```

All four run on the committed tree. Port 9008 free.

## What happened this session

### Payroll — Phase 5 opened by disproving what it was going to port

A read-only probe of the **live v1 data** before any design:

| | |
|---|---:|
| payroll runs across 7 stores | **0** — `payrollRuns` collection never created |
| payslips ever produced | **0** |
| staff with an SSS / PhilHealth / Pag-IBIG / TIN number | **0 of 126** |
| `payType` filled | 51, and **every one is `daily`** |
| `salaryAdvances` | **614** — the real staff-money process |

v1's payroll is three shipped slices, ~4,200 lines and a verified PH-2024 tax engine that **has
never paid anybody**. So the plan is not a port. `docs/plans/phase-5-payroll.md` records what the
evidence says to leave out and exactly what triggers porting the rest.

**Shipped:** `pay_rates` (effective-dated, append-only, **no `effective_to`** to drift), `pay_runs`,
`payslips`; the period-overlap guard as an `EXCLUDE USING gist` per bible §16.6; and the FK **T-157
deliberately left open** for this task. Migration `0106` opens one narrow door in T-157's freeze
trigger so a mis-posted run can be voided — without it the days were stranded for ever.

**Then, from Ian, the same day** — every premium and date became a per-store setting:
overtime as `×1.25` **or a flat amount per hour**; hours on a **25/50 ladder**; **three** holiday
multipliers keyed to `holidayType`; periods monthly / semi-monthly / weekly; payday as a lag **or
fixed days of the month**.

### ⛔ DEF-109 — the defect worth reading

`attendance_days.pending_ot_minutes` carries a warning written by the attendance lane and addressed
to Phase 5: *"Recorded, never paid here — the approval gate is Phase 5, and auto-paying it is
exactly what the pending status exists to prevent."*

**T-189 read it straight into `otMinutes` and paid it.** No test caught it — the tests were written
by the same author under the same misunderstanding. Fixed by `0110`: a sixth adjustment kind
`overtime_approved`; pay is `min(approved, worked)`; **nobody-decided pays nothing**; and unapproved
overtime is now **surfaced** on `/payroll` rather than silently dropped.

### T-186 · T-188 · the consolidation

- **T-186 till custody** — grain is *till × handover*, not attendance's *person × day*. A short
  charges `1230` to a named person; **an over posts nothing at all** (tip box), asserted by a test.
  Found **DEF-104**.
- **T-188 supplier master** — the probe disproved the reason it was picked (`bankAccounts` filled on
  **3.9%**). The real gap was **DEF-106**: a supplier could be created and never *edited*.
- **The v1→v2 parity section** on `docs/ROADMAP.html` — every field of six v1 documents classified
  *carried / moved / derived / no home*.

### Where the decisions were recorded

| Decision | Recorded in |
|---|---|
| OT ×1.25 **or** flat amount; 25/50 ladder; late exact | `docs/tasks/189-*.md` §13, migration `0107` |
| Holiday configurable — 1.3 / 1.5 / 2, **per type** | §13.3, `0107` |
| Payroll dates configurable | §14, `0108` |
| Payout date configurable | migration `0109` |
| "Undertime is provisional OT — 7h = half day + 2h to approve" | §15.2, `0110` |
| DEF-104, 105, 106, 107, 108, 109, 110 | `docs/DEFECTS-REGISTER.md` |
| Phase 5 exit gate **rewritten** (the old one was unachievable) | `docs/ROADMAP.html` |

⚠️ **Roadmap: updated.** Phase 5 wave added, T-186/188/189/189b–e carded, masthead and gate numbers
refreshed, suppliers parity row corrected 67% → 89%.

## Pick up here

1. ⭐ **Turn on `shortShiftHalfDayOt` for the stores that want Ian's model.** It defaults to
   `false` (opt-in, as in v1), so *"a 7 hour duty is halfday plus provisional 2h OT"* is **inert
   until somebody sets it**. One column, per store, and it changes pay — so it is Ian's call, not
   a default to flip quietly.
2. **A settings screen for payroll configuration.** Overtime mode, the three holiday multipliers,
   period type, cutoff day and payout days are all settings with **no UI** — `/payroll` *shows*
   them all, so nothing is invisible, but changing one needs SQL. Small, well-bounded task.
3. **T-191, 13th-month pay** — a confirmed ADD (bible row 90), and `6140` has existed since Phase 1
   with nothing posting to it.

## Do not decide these alone — they are Ian's

| Question | The recommendation already on the table |
|---|---|
| **Statutory is blocked on DATA, not effort** — 0 of 126 staff have any SSS/PhilHealth/Pag-IBIG/TIN number | Someone must enter them before T-190 can be built. ⚠️ This is also a live compliance exposure independent of software: the contributions are mandatory whether or not the ERP knows the numbers |
| **The 24-minute rule** — under 25 minutes of overtime now pays nothing | Ian set the 25/50 thresholds explicitly. If stores routinely run 20 minutes over, the fix is how overtime is *approved*, not a quieter threshold |
| **`shortShiftHalfDayOt` default** | Left `false`. Turning it on moves pay for every short shift |
| **DEF-105** — `remittance.shortage` is a documented posting pattern nothing implements | ~1 hour. A variance can be marked "charged" against a person while the ledger shows no receivable |
| **DEF-108** — an owner's drawing cap is not freed by the payroll that recovers it | Belongs to the owners lane; the scoping it would relax is what stopped a ₱600 staff shortage eating a drawing limit |
| **DEF-110 — the late/early-out grace improvement Ian asked for is NOT built** | ⚠️ Stated plainly: **v2 has no late charge at all yet**, so there is nothing for a grace to apply to. The v1 defect is recorded (v1 applies the same grace as a *cutoff* in one path and a *deduction* in another — 20 minutes late charges pay for 20 and files an infraction for 5). The fix is named: one function, and cutoff-vs-deduct as a setting defaulting to deduct. It needs the late charge to land first, which changes the payslip identity and wants its own task |

## Traps that have actually bitten — live in this area now

- ⛔ **A migration journal must keep `when` rising with `idx`.** DEF-039's damage is **permanent** on
  any database migrated during a broken window — `migrate` cannot repair it (**DEF-104**). After any
  timestamp correction, check every existing database; the remedy is drop and recreate.
- ⛔ **`attendance_days` is DERIVED from punches.** `recordAdjustment` re-adjudicates in the same
  transaction, so a fixture that inserts days directly and then calls the service will have its
  days recomputed to zero.
- ⚠️ **A CHECK constraint may not contain a subquery.** `ARRAY(SELECT generate_series(...))` fails
  the whole migration; use `ALL(...)`.
- ⚠️ **`${INPUT} w-24`** puts `w-full` and `w-24` in one class string and `w-full` wins — the form
  stacks full-width while every test stays green. **Tests assert props, never geometry.**
- ⚠️ **A comment addressed to a future module is only as good as that module reading it** (DEF-109).

## The paste-ready prompt

```
Continue on shareat-system (C:\Users\ianla\webapps\shareat-system).

Read docs/RULES.md, then docs/HANDOFF-TODAY.md. main is at 2ca399e, all gates
green (typecheck 0 · 856 unit · 1731 integration · build).

Phase 5 payroll opened yesterday and T-189 shipped — the first payslip this
business has posted from software. Read docs/plans/phase-5-payroll.md before
touching payroll: it argues from a live-data probe that v1's payroll has NEVER
produced a payslip, and it records what the evidence says NOT to port.

Start with item 1 in the handoff's "Pick up here". Before building anything,
assess it and be willing to argue against it (/research-evaluate-propose) —
probing the live v1 data has changed the shape of three tasks in a row.

Standing rules: ERP-rebuild is READ-ONLY and its name lies (it is the OLD live
ERP). No implementation without a written task spec in docs/tasks/. Verify UI in
a browser — a green build is blind to whether anyone can see the thing. Update
docs/ROADMAP.html at every wrap-up.
```
