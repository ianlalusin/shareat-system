# T-436 — Leave and absence tracking (monthly and yearly caps, paid vs unpaid)

**Status:** spec written 2026-10-16, not started. Ian answered Q1-Q6 the same day (folded in below).
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
  record of a planned absence versus a true no-show. No live count is in `docs/`; not needed, caps restart 1 Jan.

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
   employment per date. **Whole days only for go-live (Ian): no half-day leave.**
4. **Who:** request — the person themself for their own open employment (identity check, no
   capability), or a `manage_attendance` holder on their behalf. Approve / reject / record / void /
   edit caps — `manage_attendance` at that store (super/admin/manager ✅, staff ✗; reused). ⛔ **Ian:
   managers and admins cannot approve or record their OWN leave; only super_admin can** (stricter than
   v1's OT rule because leave moves pay UP).
5. **Cap and balance check at approval, inside the transaction:** lock the employment row
   (`SELECT … FOR UPDATE`), count, then write. Refusals are typed (`LEAVE_CAP_MONTHLY`,
   `LEAVE_CAP_YEARLY`, `SIL_BALANCE_EXHAUSTED`, `LEAVE_DAY_WORKED`, `LEAVE_OWN_APPROVAL`) with the
   numbers ("sick: 2 of 2 this month"), never raw throws (t343 ratchet).
6. **SIL balance**, derived not stored: entitlement for the year minus approved paid days with
   `draws_sil` in that year. **Year = calendar year; caps and SIL reset every 1 Jan for everyone (Ian).**
   Entitlement = 5 if the 1-year anniversary (`started_on` + 1 year) is on or before 1 Jan. **In the
   year of the anniversary, pro-rated (Ian):** `round_half_up(5 × M / 12)` whole days, where M = whole
   calendar months from the anniversary to 31 Dec (the anniversary month counts only if it falls on
   the 1st). E.g. anniversary 1 Jun → M=7 → 3 days; 15 Jun → M=6 → 3 (2.5 rounds up); 1 Dec → M=1 → 0.
   Before the anniversary year: 0.
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
9. **Year-end SIL cash payout, through payroll (Ian: unused SIL is PAID OUT, never carried over).**
   `leave_commutations` (unique per employment per year: `days`, `daily_rate`, `amount`,
   `payroll_run_id`). The payroll run whose period contains 31 Dec computes, for every employment with
   unused SIL that year, `days` = entitlement − used, `daily_rate` = rate in force on 31 Dec, `amount`
   = days × rate (`@shareat/core/money`), and adds it to the slip as `silConversionPay` inside
   `grossPay` (so T-190 deductions see it), freezing the row to the run in the same transaction. A
   second run covering 31 Dec finds the row frozen and adds nothing; voiding the run releases it.
   Once frozen, approving any SIL-drawing day in that year is refused (`SIL_YEAR_CLOSED`). An
   employment that ends before 31 Dec gets its unused SIL in final pay instead (`payroll/separation.ts`
   calls the same function and writes the row, so year-end skips it).
10. **Personal data (row 353):** the request `note` (reason, medical detail) is returned by the loader
    only to the person themself and `manage_attendance` holders at that store; lists, the grid,
    exports, logs and audit payloads carry the kind only, never the note.
10a. **Medical-certificate photos (Ian: YES).** A manager with `manage_attendance` at the store may
    attach photos to a request through the file broker: new `stored_files` purpose `leave_document`
    (jpeg/png/webp, `MAX_IMAGE_BYTES`, EXIF stripped), `linked_to` = request id (sweep-proof). **Who
    may view (row 353):** (a) while pending, a `manage_attendance` holder at that store other than
    the employee; after a decision, only the manager who approved/recorded it, while still holding
    `manage_attendance` there; (b) payroll staff: new capability `view_leave_document` (store-scoped;
    super ✅, admin ✅, manager ✗, staff ✗; position-grantable, e.g. payroll clerk; matrix row);
    (c) admins/super. Reads route only through `assertCanReadLeaveDocument` (never the generic
    `canReadFiles` / `PURPOSE_CAPABILITY` path, as T-434 did for signatures);
    `PURPOSE_CAPABILITY.leave_document = 'manage_attendance'` governs UPLOAD only. Links live 60 s.
    Everyone else sees "Proof attached" (a boolean); lists, grid and exports never carry the file id.
    Every view writes `leave_document.viewed`; a refused attempt writes `leave_document.view_refused`
    in a separate transaction; a guessed `/files/<id>` returns the same 404 as a missing file. Audit
    payloads carry no file id, path or URL.
11. **Audit:** `leave.requested|approved|rejected|cancelled|recorded|voided|paid_override`,
    `leave_cap.changed`, `leave_type.changed`, `sil.commuted` — actor, time, employment, dates, kind;
    no note text. `no_show` recorded → emits the infraction hook only once infractions exist (Phase 7);
    until then the record itself is the evidence.
12. **Migration: yes — `0205_t436_leave_tracking.sql`** (confirmed). Also widens
    `stored_files_purpose_check` with `leave_document` (on top of T-434's widening). Journal
    idx 205, `when` 1803785507084 (0204's + 86400000). ⛔ T-434 (0204) merges first. Five tables
    above, seeds for the kinds, hand-authored per ADR-012 §5; classify each table in
    `cutover/classification.ts` and `rls/registry.ts`; same-org FKs. Full suite on a fresh gate DB.
    No v1 ETL (caps restart 1 Jan).

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
- `packages/db/schema/stored-files.ts` (`FILE_PURPOSES`), `packages/domain/src/files/index.ts` (limits, read routing)
- `packages/domain/src/leave/` (new: `index.ts`, `caps.ts`, `sil.ts`, `documents.ts`)
- `packages/domain/src/payroll/compute.ts`, `index.ts`, `separation.ts`
- `packages/auth/` capability list (`view_leave_document`)
- `apps/erp/src/app/attendance/` (page, `lib.ts`, `leave/` actions), `apps/erp/src/app/settings/attendance/`
- `docs/decisions/CAPABILITY-MATRIX.md` (`view_leave_document` row; `manage_attendance` now covers leave)

## TESTER paths (tests only, disjoint)

- `packages/domain/tests/integration/t436-leave.test.ts`
- `packages/domain/tests/integration/t436-leave-payroll.test.ts`
- `packages/domain/tests/unit/t436-leave-caps-sil.test.ts`
- `packages/domain/tests/integration/t436-leave-documents.test.ts`
- `apps/erp/tests/t436-leave-surfaces.test.ts`

## Cases (each names the mutant it kills)

1. Sick monthly cap 2: third sick day in the same month refused `LEAVE_CAP_MONTHLY` with "2 of 2". *Mutant: monthly check removed.*
2. Yearly cap 5 used up by March; a fresh month still refused `LEAVE_CAP_YEARLY`. *Mutant: caps not independent (yearly only checked when monthly passes).*
3. Voided and rejected days do not count toward a cap. *Mutant: count ignores status.*
4. Position cap overrides the org default; store+position overrides position. *Mutant: first row wins instead of most specific.*
5. Two approvals racing for the last cap slot: exactly one succeeds. *Mutant: lock removed.*
6. Second live leave day for the same employment and date refused by the unique index. *Mutant: partial index dropped.*
7. Staff-role actor approves → refused; manager of store B approves store-A leave → refused. *Mutant: capability or store scope dropped.*
8. Manager approves own leave → `LEAVE_OWN_APPROVAL`; admin approves or records own leave → refused; super_admin may. *Mutant: guard removed, or admins exempted as in v1's OT rule.*
9. Staff requests own leave → pending; requests for a colleague → refused. *Mutant: identity check missing.*
10. Future-dated `record` refused; future-dated request accepted. *Mutant: v1 future guard lost or applied to requests.*
11. `no_show` cannot be requested, only recorded, and is always unpaid. *Mutant: requestable/paid flags ignored.*
12. Statutory cap set below the legal yearly limit → refused. *Mutant: statutory floor not enforced.*
13. SIL 2027: started 2025-12-15 → 5 (anniversary before 1 Jan); 2026-06-01 → 3; 2026-06-15 → 3; 2026-12-01 → 0; 2027-02-01 → 0. *Mutant: eligibility off-by-one, proration skipped, or rounding down.*
14. Sixth paid SIL day refused `SIL_BALANCE_EXHAUSTED`; approved as unpaid with `paid_override` audit. *Mutant: balance not checked.*
15. Approval on a date with a payable attendance day → `LEAVE_DAY_WORKED`. *Mutant: worked-day check dropped.*
16. Payroll: 2 paid leave days at ₱600 → `leavePay` ₱1,200 in gross, no OT/ND/holiday on them. *Mutant: leave priced with premiums or left out of gross.*
17. Unpaid leave adds ₱0. *Mutant: paid flag ignored.*
18. Punches arrive on an approved paid leave date → paid once, as worked. *Mutant: double pay.*
19. Leave days frozen to a run cannot be paid by a second run; voiding the run releases them. *Mutant: freeze/release missing.*
20. Year-end: 3 unused SIL days × rate on 31 Dec appear as `silConversionPay` inside gross of the run covering 31 Dec; a second run pays nothing more; voiding the run releases it. *Mutant: payout not idempotent or outside gross.*
20a. After the payout is frozen, approving a paid SIL day in that year → `SIL_YEAR_CLOSED`. *Mutant: late approval double-counts.*
20b. Employment ended 30 Jun: unused SIL paid in final pay; the year-end run skips it. *Mutant: paid twice.*
20c. Reset on 1 Jan: a person at the yearly cap on 31 Dec can take leave on 2 Jan. *Mutant: rolling 12-month window.*
21. Note text visible to the person and a `manage_attendance` holder; a store-B manager and a colleague get no `note` key in loader data. *Mutant: loader returns note, UI hides it.*
22. Grid, list and CSV export contain no note; audit payloads contain no note text. *Mutant: note selected in list/audit.*
23. Every transition writes its audit row with actor, time, employment, dates, kind. *Mutant: audit skipped on void or reject.*
24. Rejected, cancelled and voided requests need the actor; void needs a reason. *Mutant: void reason optional.*
25. Grid shows Paid/Unpaid badge per leave date and a clash flag when punches exist. *Mutant: badge not rendered.*
26. A half-day request → refused. *Mutant: portion field accepted.*
27. Manager attaches a cert: purpose `leave_document`, EXIF stripped, `linked_to` = request; a staff-role upload → refused. *Mutant: wrong purpose or capability check dropped.*
28. Approving manager, a `view_leave_document` holder and an admin each get a 60 s link and a `viewed` audit row. *Mutant: view not audited.*
29. A colleague, a store-B manager, a second store-A manager after another manager decided, and the employee each get only `hasProof: true`: no file id in loader data, no link. *Mutant: loader returns the id, UI hides it.*
30. A guessed `/files/<id>` for a `leave_document` by an unauthorised viewer → same 404 as a missing id, body names nothing, and a `view_refused` row survives the rollback. *Mutant: read falls through to `canReadFiles` (manage_attendance), or the refusal leaks existence.*
31. Grid, lists, CSV export and audit payloads carry no proof file id, path or URL. *Mutant: id selected in a list.*

## Ian's answers (2026-10-16)

Q1 reset every 1 Jan for everyone · Q2 unused SIL paid out as cash through payroll (D9) · Q3 whole
days only · Q4 managers attach medical-certificate photos, row-353 guarded (D10a) · Q5 pro-rated SIL
in the anniversary year (D6) · Q6 no self-approval for managers or admins, super_admin only (D4).
