# T-436 — Leave and absence tracking (monthly and yearly caps, paid vs unpaid)

**Status:** spec written 2026-10-16, not started
**Model:** Sonnet (money + auth lane). Write any spec amendment in plan mode.
**Sources:** bible row 354 item 2 (Ian 2026-10-16: build before the 1 Jan go-live); row 353 (personal
data guarded); `docs/plans/phase-4-attendance.md:83,354` (deliverable 7, was T-165);
`docs/CAPABILITY-GAPS.md:91,182`; `docs/discovery/15-capabilities-people.md:241-248`.

## Goal, in plain words

A manager can record that a staff member was absent, or a staff member can ask for a day off and a
manager approves it. Each kind of leave has a monthly and a yearly limit that the system enforces.
Approved leave shows on the attendance grid, and payroll pays it or not depending on the kind. The
legally required 5 paid days a year (Service Incentive Leave) are tracked as a balance. Every change
is logged, and the reason or medical note is shown only to the people who need it.

## Research (v1 goal, the law, then the v2 design)

**What v1 does** (`ERP-rebuild/src/lib/actions/absentee.actions.ts`, `absentee-settings.actions.ts`,
`src/types/index.ts:2361-2393`, settings UI `src/app/manager/settings/attendance/leave-limits-section.tsx`):
- Records a past absence only (future dates refused). No request, no approval, no paid/unpaid idea.
- Reasons: `no_show`, `sick`, `personal`, `emergency`. Caps per reason per STORE (not per position),
  `monthly` and `yearly` counts, independent: either one breached refuses. Calendar month and year.
- Recorders: cashier, manager, admin. `no_show` auto-files the "Absent Without Notice" infraction.
- Void with reason. Payroll never reads it. Cap counting is read-then-write with no lock (two
  cashiers can both slip under the cap).
- **v1's goal:** stop staff taking more than a set number of sick/personal/emergency days, and keep a
  record of a planned absence versus a true no-show. No live count is in `docs/`; not needed, see Q1.

**What the law requires** (minimum; DOLE / SSS):
- **Service Incentive Leave, Labor Code Art. 95:** 5 days PAID a year once an employee has 1 year of
  service. Unused days must be **converted to cash** at year end. (Exempt only below 10 employees; the
  org is well above that.) **In scope.**
- **Maternity (RA 11210, 105 days), paternity (RA 8187, 7 days), solo parent (RA 11861, 7 days after
  6 months' service), VAWC (RA 9262, 10 days), women's special leave (RA 9710).** In scope as leave
  KINDS with their legal day limits, paid flag and a "needs proof" flag. **Out of scope:** the SSS
  maternity benefit money (advance, reimbursement, salary differential) — goes with T-190/T-193.

**Where v2 beats v1:** (1) a cap is a limit on a KIND; the paid SIL entitlement is a separate BALANCE,
so a sick day can be paid (draws SIL) or unpaid; (2) caps per kind with optional position and store
overrides; (3) advance requests with approval, plus v1's after-the-fact record; (4) cap check under a
row lock, so two recorders cannot both pass; (5) payroll actually pays paid leave and freezes it.

## Decisions

1. **Leave kinds** (`leave_types`, org-level, seeded, admin can add/retire, never delete): `no_show`
   (unpaid, never requestable, record-only), `sick`, `personal`, `emergency`, `sil` (paid, draws SIL),
   `maternity`, `paternity`, `solo_parent`, `vawc`, `special_women`, `unpaid_other`. Columns: `code`,
   `label`, `paid` (default pay mode), `draws_sil`, `statutory`, `needs_proof`, `requestable`, `active`.
2. **Caps** (`leave_caps`): `(org, leave_type, store_id NULL, position_id NULL, monthly_cap NULL,
   yearly_cap NULL)`. NULL cap = no limit. Most specific row wins: store+position > position > store
   > org default. Statutory kinds carry their legal yearly limit and **cannot be lowered** below it
   (CHECK in the domain). Caps count approved + recorded days in the calendar month / year of each date.
3. **Requests** (`leave_requests` header + `leave_request_days`, one row per date). Status:
   `pending → approved | rejected`, `pending → cancelled` (by requester), `approved → voided` (reason
   required). A manager "record" creates the request already `approved` (v1's flow, past dates allowed;
   future dates only via request). Partial unique index: one live (pending/approved) leave day per
   employment per date. Full days only (half days: Q4).
4. **Who:** request — the person themself for their own open employment (identity check, no
   capability), or a `manage_attendance` holder on their behalf. Approve / reject / record / void /
   edit caps — `manage_attendance` at that store (super/admin/manager ✅, staff ✗; reused, no new
   capability). ⛔ Nobody approves or records their OWN leave, admins included except super_admin
   (stricter than v1's OT rule because leave moves pay UP).
5. **Cap and balance check at approval, inside the transaction:** lock the employment row
   (`SELECT … FOR UPDATE`), count, then write. Refusals are typed (`LEAVE_CAP_MONTHLY`,
   `LEAVE_CAP_YEARLY`, `SIL_BALANCE_EXHAUSTED`, `LEAVE_DAY_WORKED`, `LEAVE_OWN_APPROVAL`) with the
   numbers ("sick: 2 of 2 this month"), never raw throws (t343 ratchet).
6. **SIL balance**, derived not stored: entitlement for the year minus approved paid days with
   `draws_sil` in that year. Entitlement = 5 if `employments.started_on` ≤ 1 year before 1 Jan; in the
   year the person reaches 1 year, prorated by whole months left (Q2). Year = **calendar year** (Q1).
   A paid day of a kind that draws SIL when the balance is 0 is refused; the manager may approve it
   as unpaid instead (explicit `paid=false` on the request, audited).
7. **Attendance grid:** reads leave days alongside `attendance_days` (no change to that table). A
   leave date shows a badge with the kind and Paid/Unpaid; the note is never on the grid. Approval is
   refused if a payable attendance day exists that date. If punches arrive later on a leave date, the
   grid flags the clash and payroll pays the worked day only (never both).
8. **Payroll:** `payrollRepo.payableLeaveDays` returns approved paid leave days in the period not on a
   worked date. `compute.ts` adds `leavePay` = daily rate in force that day × 1, into `grossPay`
   (basic only — no OT, night diff or holiday premium). Unpaid leave adds nothing (no day exists).
   Leave days are frozen to the run (`leave_request_days.payroll_run_id`); voiding the run releases
   them, exactly as attendance days. T-190 deductions then see `leavePay` inside gross.
9. **Year-end SIL conversion** (`leave_commutations`, one row per employment per year, unique):
   unused SIL days × daily rate on 31 Dec, paid as a `silConversionPay` line in the run whose period
   contains 31 Dec. Idempotent; voiding that run releases the row.
10. **Personal data (row 353):** the request `note` (reason, medical detail) is returned by the loader
    only to the person themself and `manage_attendance` holders at that store; lists, the grid,
    exports, logs and audit payloads carry the kind only, never the note. Medical proof files: Q3.
11. **Audit:** `leave.requested|approved|rejected|cancelled|recorded|voided|paid_override`,
    `leave_cap.changed`, `leave_type.changed`, `sil.commuted` — actor, time, employment, dates, kind;
    no note text. `no_show` recorded → emits the infraction hook only once infractions exist (Phase 7);
    until then the record itself is the evidence.
12. **Migration: yes — `0205_t436_leave_tracking.sql`** (orchestrator to confirm the number). Journal
    idx 205, `when` 1803785507084 (0204's + 86400000). ⛔ T-434 (0204) merges first. Five tables
    above, seeds for the kinds, hand-authored per ADR-012 §5; classify each table in
    `cutover/classification.ts` and `rls/registry.ts`; same-org FKs. Full suite on a fresh gate DB.
    No v1 ETL (calendar-year caps restart 1 Jan, Q1).

## Slices

- **S1** migration, schema, repo, seeds, classification/RLS.
- **S2** domain: request, record, approve, reject, cancel, void; cap resolution; SIL balance; locking.
- **S3** settings UI for kinds and caps (`settings/attendance`); request/approve UI on `attendance`.
- **S4** grid badges and clash flag.
- **S5** payroll: `leavePay`, freeze/release, year-end SIL conversion.

## BUILDER paths (source)

- `packages/db/migrations/0205_t436_leave_tracking.sql`, `packages/db/migrations/meta/_journal.json`
- `packages/db/schema/leave.ts` (new), `packages/db/schema/index.ts`
- `packages/db/src/repo/leave.ts` (new), `packages/db/src/repo/payroll.ts` (`payableLeaveDays`)
- `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts`, same-org FK lists
- `packages/domain/src/leave/` (new: `index.ts`, `caps.ts`, `sil.ts`)
- `packages/domain/src/payroll/compute.ts`, `packages/domain/src/payroll/index.ts`
- `apps/erp/src/app/attendance/` (page, `lib.ts`, `leave/` actions), `apps/erp/src/app/settings/attendance/`
- `docs/decisions/CAPABILITY-MATRIX.md` (note on `manage_attendance` now covering leave)

## TESTER paths (tests only, disjoint)

- `packages/domain/tests/integration/t436-leave.test.ts`
- `packages/domain/tests/integration/t436-leave-payroll.test.ts`
- `packages/domain/tests/unit/t436-leave-caps-sil.test.ts`
- `apps/erp/tests/t436-leave-surfaces.test.ts`

## Cases (each names the mutant it kills)

1. Sick monthly cap 2: third sick day in the same month refused `LEAVE_CAP_MONTHLY` with "2 of 2". *Mutant: monthly check removed.*
2. Yearly cap 5 used up by March; a fresh month still refused `LEAVE_CAP_YEARLY`. *Mutant: caps not independent (yearly only checked when monthly passes).*
3. Voided and rejected days do not count toward a cap. *Mutant: count ignores status.*
4. Position cap overrides the org default; store+position overrides position. *Mutant: first row wins instead of most specific.*
5. Two approvals racing for the last cap slot: exactly one succeeds. *Mutant: lock removed.*
6. Second live leave day for the same employment and date refused by the unique index. *Mutant: partial index dropped.*
7. Staff-role actor approves → refused; manager of store B approves store-A leave → refused. *Mutant: capability or store scope dropped.*
8. Manager approves or records own leave → `LEAVE_OWN_APPROVAL`; super_admin may. *Mutant: self-approval guard removed.*
9. Staff requests own leave → pending; requests for a colleague → refused. *Mutant: identity check missing.*
10. Future-dated `record` refused; future-dated request accepted. *Mutant: v1 future guard lost or applied to requests.*
11. `no_show` cannot be requested, only recorded, and is always unpaid. *Mutant: requestable/paid flags ignored.*
12. Statutory cap set below the legal yearly limit → refused. *Mutant: statutory floor not enforced.*
13. SIL: started 2024-03-01 → 5 days in 2027; started 2026-06-01 → prorated per Q2 rule; started 2026-12-01 → 0. *Mutant: eligibility off-by-one or proration skipped.*
14. Sixth paid SIL day refused `SIL_BALANCE_EXHAUSTED`; approved as unpaid with `paid_override` audit. *Mutant: balance not checked.*
15. Approval on a date with a payable attendance day → `LEAVE_DAY_WORKED`. *Mutant: worked-day check dropped.*
16. Payroll: 2 paid leave days at ₱600 → `leavePay` ₱1,200 in gross, no OT/ND/holiday on them. *Mutant: leave priced with premiums or left out of gross.*
17. Unpaid leave adds ₱0. *Mutant: paid flag ignored.*
18. Punches arrive on an approved paid leave date → paid once, as worked. *Mutant: double pay.*
19. Leave days frozen to a run cannot be paid by a second run; voiding the run releases them. *Mutant: freeze/release missing.*
20. Year-end: 3 unused SIL days × rate on 31 Dec paid once in the run covering 31 Dec; re-running pays nothing more. *Mutant: commutation not idempotent.*
21. Note text visible to the person and a `manage_attendance` holder; a store-B manager and a colleague get no `note` key in loader data. *Mutant: loader returns note, UI hides it.*
22. Grid, list and CSV export contain no note; audit payloads contain no note text. *Mutant: note selected in list/audit.*
23. Every transition writes its audit row with actor, time, employment, dates, kind. *Mutant: audit skipped on void or reject.*
24. Rejected, cancelled and voided requests need the actor; void needs a reason. *Mutant: void reason optional.*
25. Grid shows Paid/Unpaid badge per leave date and a clash flag when punches exist. *Mutant: badge not rendered.*

## Questions for Ian

- **Q1 Year:** calendar year (1 Jan–31 Dec) for caps and SIL — **recommended**: matches v1, the go-live
  date, and one reset for everyone. The alternative, each person's hire anniversary, is fairer to
  new hires but harder to read.
- **Q2 First-year SIL:** prorate in the year someone reaches 1 year (recommended) or give all 5 days.
- **Q3 Medical proof:** let managers attach a photo of a medical certificate now (guarded like the
  signature, needs one more file kind) or keep notes only for go-live (recommended: notes only).
- **Q4 Half-day leave:** not in v1; leave out for go-live (recommended) or add now.
- **Q5 Unused SIL:** the law says convert to cash at year end (default here). Carrying days over
  instead needs your written policy.
