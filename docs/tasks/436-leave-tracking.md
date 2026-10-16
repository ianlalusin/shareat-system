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
   > org default. Caps count approved + recorded leave days of the PERSON (all their jobs in the org)
   in the calendar month / year of each date. ⛔ **Maternity (105 days) and paternity (7 days, first 4
   deliveries) are per BIRTH, never under monthly/yearly caps:** the request carries `birth_date` and
   is checked against the per-birth limit (and paternity against the 4-delivery count), not `leave_caps`.
   Other statutory kinds carry their legal yearly limit and **cannot be lowered** below it.
3. **Scope is the PERSON in the org, not the employment** (orchestrator ruling): service, SIL, caps
   and "one leave day per date" are all per person, so a person with two concurrent jobs or a store
   transfer keeps one balance and one service date. **Service start** = earliest `started_on` of the
   person's current unbroken chain of org employments (a day with no open employment breaks the chain).
4. **Requests** (`leave_requests` header with `person_id` + the `employment_id` it is filed under,
   + `leave_request_days`, one row per date). Status: `pending → approved | rejected`,
   `pending → cancelled` (by requester), `approved → voided` (reason required). A manager "record"
   creates the request already `approved` (v1's flow, past dates allowed; future dates only via
   request). Partial unique index: one live (pending/approved) leave day per **person** per date.
   **Whole days only (Ian).** **Rest days:** v2 has no roster, so each date in a range is marked
   `leave` or `rest_day` by the requester or approver; `rest_day` rows are not paid, do not use SIL
   and do not count toward caps.
5. **Who:** request — the person themself for their own open employment (identity check, no
   capability), or a `manage_attendance` holder on their behalf. Approve / reject / record / void /
   edit caps — `manage_attendance` at the filing store (super/admin/manager ✅, staff ✗; reused).
   ⛔ **Self-approval (Ian): refused when approver PERSON = requester PERSON, unless the approver is
   super_admin** (who may approve their own, audited `leave.self_approved`). Keyed on the person,
   never the role, because `manage_attendance` is position-grantable.
6. **Transitions are race-safe.** Approve, reject and cancel lock the person row
   (`SELECT … FOR UPDATE`), then `UPDATE … WHERE id = $1 AND status = 'pending'` and check the row
   count is 1 (0 → typed `LEAVE_NOT_PENDING`). Cap and SIL counts are taken under the same lock.
   Refusals are typed (`LEAVE_CAP_MONTHLY`, `LEAVE_CAP_YEARLY`, `LEAVE_BIRTH_LIMIT`,
   `SIL_BALANCE_EXHAUSTED`, `SIL_BEFORE_ANNIVERSARY`, `SIL_YEAR_CLOSED`, `LEAVE_DAY_WORKED`,
   `LEAVE_OWN_APPROVAL`, `LEAVE_DAY_PAID`) with the numbers ("sick: 2 of 2 this month"), never raw
   throws (t343 ratchet).
7. **SIL balance**, derived not stored: entitlement for the year minus approved paid `draws_sil`
   leave days in that year. **Calendar year; caps and SIL reset every 1 Jan for everyone (Ian).**
   Full 5 days if the 1-year anniversary (service start + 1 year) is on or before 1 Jan. **In the
   anniversary year: `ceil(5 × M / 12)` days**, M = calendar months left counting the anniversary
   month (anniversary 1 Jun or 15 Jun → M=7 → 3 days; 1 Dec → M=1 → 1 day), usable only on dates ON
   or after the anniversary (`SIL_BEFORE_ANNIVERSARY`). Before that year: 0. ⚠️ **Pro-rating is
   company policy, not law (Art. 95 only requires 5 days after a full year); the accountant/HR should
   confirm it with DOLE.** A paid SIL-drawing day with balance 0 is refused; the manager may approve
   it as unpaid (`paid=false`, audited `leave.paid_override`).
8. **"Worked date" = any `attendance_days` row for that person and date that is not voided,
   including `needs_review`.** Approval on a worked date → `LEAVE_DAY_WORKED`. If punches arrive later
   on an approved leave date: if the leave day is not yet paid, it becomes `superseded_by_work`
   (not paid, SIL day given back); if it was already paid in a run, the attendance day is held from
   payroll as `needs_review` with a clash flag so it is not paid twice, and the manager resolves it
   (void the attendance day, or void the leave day after that run is voided). Grid shows the badge
   (kind, Paid/Unpaid) and the clash flag; never the note.
9. **Payroll.** `payrollRepo.payableLeaveDays` returns approved paid `leave` days in the period that
   are not on a worked date and not frozen. `compute.ts` adds `leavePay` = daily rate in force that day
   × 1 (no OT, night diff or holiday premium). Leave days freeze to the run via
   **`leave_request_days.frozen_by_pay_run_id` + `frozen_at`** (same names and pair-CHECK as
   `attendance_days`); voiding the run releases them. ⛔ **Voiding a leave day frozen to a posted run
   is refused** (`LEAVE_DAY_PAID`); void the run first. **Maternity and paternity are recorded with
   `paid=false` for `leave_pay`**: maternity is paid via SSS reimbursement and paternity pay is
   handled with T-190/T-193, not here.
10. **Payslip columns (migration 0205):** `payslips.leave_pay` and `payslips.sil_conversion_pay`,
    `numeric(14,2) NOT NULL DEFAULT 0`, and `payslips_gross_identity_check` (0105:99) is dropped and
    re-added as `gross_pay = basic_pay + ot_pay + night_diff_pay + holiday_pay + leave_pay +
    sil_conversion_pay`. ⛔ **Neither goes into `basic_pay`:** the 13th month reads `basicPay`, and
    PD 851's rules exclude leave conversions from it. T-190 deductions see both inside gross.
11. **Year-end SIL cash payout (Ian: paid out, never carried over).** `leave_commutations` (unique per
    PERSON per year: `days`, `daily_rate`, `amount`, `employment_id`, `frozen_by_pay_run_id`,
    `separation_id`, CHECK at most one of the two set). **Designated employment** = the person's
    employment open on 31 Dec with the earliest `started_on` (ties: lowest id); `daily_rate` = its
    rate in force on 31 Dec. The run of that employment's store whose period contains 31 Dec pays
    `amount = days × rate` (`@shareat/core/money`) into `sil_conversion_pay`. **If that person has no
    other slip in the run, the run creates one for the designated employment with `days_worked = 0`
    and only `sil_conversion_pay`**, so nobody is missed. Row frozen in the same transaction; a second
    run finds it frozen and pays nothing; voiding the run releases it. Once frozen, approving any
    SIL-drawing day that year → `SIL_YEAR_CLOSED`.
12. **Final pay instead of year end:** when the person's last open employment is separated before
    31 Dec, `postSeparation` writes the commutation row with `separation_id` and a journal line for
    it; `voidSeparation` releases the row and reverses the line. ⛔ A row is paid by a separation OR
    a run, never both (CHECK + the frozen check at both payers).
13. **Personal data (row 353):** the request `note` is returned by the loader only to the person
    themself and `manage_attendance` holders at the filing store; lists, the grid, exports, logs and
    audit payloads carry the kind only.
14. **Medical-certificate photos (Ian: YES).** A `manage_attendance` holder at the store attaches
    photos through the file broker: new `stored_files` purpose `leave_document` (jpeg/png/webp,
    `MAX_IMAGE_BYTES`, EXIF stripped), `linked_to` = request id (sweep-proof). **Who may view:**
    (a) while pending, a `manage_attendance` holder at that store who is not the employee; after a
    decision, only the person who approved/recorded it, while still holding `manage_attendance` there;
    (b) payroll staff: new capability `view_leave_document` (store-scoped; super ✅, admin ✅,
    manager ✗, staff ✗; position-grantable; matrix row); (c) admins/super. Reads route only through
    `assertCanReadLeaveDocument`, never `canReadFiles` / `PURPOSE_CAPABILITY` (which governs UPLOAD
    only), as T-434 did for signatures. **Links last 60 s**, enforced in `readFileUrl` for this
    purpose (the `/files` route default is 300 s). Others see "Proof attached" (a boolean); lists,
    grid and exports never carry the file id. Every view writes `leave_document.viewed`; a refused
    attempt writes `leave_document.view_refused` in a separate transaction; a guessed `/files/<id>`
    returns the same 404 as a missing file. Audit payloads carry no file id, path or URL.
15. **Audit:** `leave.requested|approved|self_approved|rejected|cancelled|recorded|voided|
    paid_override|superseded_by_work`, `leave_cap.changed`, `leave_type.changed`, `sil.commuted` —
    actor, time, person, dates, kind; no note text. `no_show` emits the infraction hook only once
    infractions exist (Phase 7).
16. **Migration: yes — `0205_t436_leave_tracking.sql`** (confirmed). Journal idx 205, `when`
    1803785507084 (0204's + 86400000). ⛔ T-434 (0204) merges first. Five tables, seeds for the
    kinds, the two payslip columns and the rewritten gross identity (D10), and
    `stored_files_purpose_check` re-created listing **all 8 purposes**: the 5 from 0032, `staff_photo`
    and `staff_signature` from 0204, and `leave_document`. Hand-authored per ADR-012 §5; classify
    each table in `cutover/classification.ts` and `rls/registry.ts`; same-org FKs. Full suite on a
    fresh gate DB. No v1 ETL (caps restart 1 Jan).

## Slices

- **S1** migration, schema, repo, seeds, classification/RLS.
- **S2** domain: request, record, approve, reject, cancel, void; caps; per-birth limits; SIL; locking.
- **S3** settings UI for kinds and caps (`settings/attendance`); request/approve UI on `attendance`.
- **S4** grid badges, clash flag, supersede-by-work.
- **S5** payroll: `leave_pay`, freeze/release, year-end payout, final-pay payout.
- **S6** medical-certificate files.

## BUILDER paths (source)

- `packages/db/migrations/0205_t436_leave_tracking.sql`, `packages/db/migrations/meta/_journal.json`
- `packages/db/schema/leave.ts` (new), `packages/db/schema/index.ts`, `packages/db/schema/payroll.ts`
- `packages/db/src/repo/leave.ts` (new), `packages/db/src/repo/payroll.ts` (`payableLeaveDays`)
- `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts`, same-org FK lists
- `packages/db/schema/stored-files.ts` (`FILE_PURPOSES`), `packages/domain/src/files/index.ts`
- `packages/domain/src/leave/` (new: `index.ts`, `caps.ts`, `sil.ts`, `documents.ts`)
- `packages/domain/src/payroll/compute.ts`, `index.ts`, `separation.ts`
- `packages/auth/` capability list (`view_leave_document`)
- `apps/erp/src/app/attendance/` (page, `lib.ts`, `leave/` actions), `apps/erp/src/app/settings/attendance/`
- `docs/decisions/CAPABILITY-MATRIX.md` (`view_leave_document` row; `manage_attendance` now covers leave)

## TESTER paths (tests only, disjoint)

- `packages/domain/tests/integration/t436-leave.test.ts`
- `packages/domain/tests/integration/t436-leave-races.test.ts`
- `packages/domain/tests/integration/t436-leave-payroll.test.ts`
- `packages/domain/tests/integration/t436-leave-documents.test.ts`
- `packages/domain/tests/unit/t436-leave-caps-sil.test.ts`
- `packages/db/tests/integration/t436-leave-migration.test.ts`
- `apps/erp/tests/t436-leave-surfaces.test.ts`

## Cases (each names the mutant it kills)

1. Sick monthly cap 2: third sick day in the same month refused `LEAVE_CAP_MONTHLY` with "2 of 2". *Mutant: monthly check removed.*
2. Yearly cap 5 used up by March; a fresh month still refused `LEAVE_CAP_YEARLY`. *Mutant: yearly check removed (only the monthly count is checked).*
3. Voided, rejected, cancelled and `rest_day` rows do not count toward a cap. *Mutant: count ignores status or day kind.*
4. Position cap overrides the org default; store+position overrides position. *Mutant: first row wins instead of most specific.*
5. Two approvals for the last cap slot on two real connections released by a barrier: exactly one succeeds, the other gets `LEAVE_CAP_*`. *Mutant: lock removed.*
5a. Approve and cancel of the same pending request on two connections with a barrier: one wins, the other gets `LEAVE_NOT_PENDING`; final status matches the winner. *Mutant: `WHERE status='pending'` or row-count check dropped, or cancel skips the lock.*
6. Same person, two concurrent jobs (stores A and B): a leave day at A blocks the same date at B; caps and SIL count both jobs; one balance. *Mutant: scope keyed on employment.*
6a. Transfer A→B with no gap: service start stays A's `started_on`; a one-day gap restarts it. *Mutant: service from the latest employment.*
7. Staff-role actor approves → refused; store-B manager approves store-A leave → refused. *Mutant: capability or store scope dropped.*
8. Manager approves own leave → `LEAVE_OWN_APPROVAL`; admin → refused; a staff member with position-granted `manage_attendance` → refused; super_admin may, audited `leave.self_approved`. *Mutant: guard keyed on role, or admins exempted.*
9. Staff requests own leave → pending; for a colleague → refused. *Mutant: identity check missing.*
10. Future-dated `record` refused; future-dated request accepted. *Mutant: v1 future guard lost or applied to requests.*
11. `no_show` cannot be requested, only recorded, and is always unpaid. *Mutant: requestable/paid flags ignored.*
12. Statutory yearly limit cannot be lowered; maternity 105 days for one birth is accepted with yearly cap 5 on file; day 106 → `LEAVE_BIRTH_LIMIT`; a 5th paternity delivery → refused. *Mutant: per-birth kinds run through monthly/yearly caps.*
13. SIL 2027 (unit): service start 2025-12-15 → 5; 2026-01-01 → 5; 2026-06-01 → 3; 2026-06-15 → 3; 2026-12-01 → 1; 2027-02-01 → 0. *Mutant: rounding down/half-up, or off-by-one on the anniversary month.*
13a. Service start 2026-06-15: a paid SIL day on 2027-05-10 → `SIL_BEFORE_ANNIVERSARY`; on 2027-06-20 → allowed. *Mutant: pro-rated days usable before the anniversary.*
14. Sixth paid SIL day refused `SIL_BALANCE_EXHAUSTED`; approved as unpaid with `paid_override` audit. *Mutant: balance not checked.*
15. Approval on a date with an attendance day in `needs_review` → `LEAVE_DAY_WORKED`. *Mutant: only computed/verified days count as worked.*
16. Payroll: 2 paid leave days at ₱600 → `leave_pay` ₱1,200, `basic_pay` unchanged, gross identity holds. *Mutant: leave added to basic, or priced with premiums.*
17. Unpaid leave and `rest_day` rows add ₱0 and use no SIL. *Mutant: paid flag or day kind ignored.*
18. Leave paid first: a run pays a leave day, then punches arrive → the attendance day is held `needs_review` with a clash flag and is not paid in the next run. *Mutant: double pay.*
18a. Punches first: leave approved, punches arrive before any run → leave day `superseded_by_work`, paid once as worked, SIL balance goes back up by 1. *Mutant: SIL day not given back.*
19. Leave days frozen to a run are not picked by a second run; voiding the run releases them. *Mutant: freeze/release missing.*
19a. Voiding a leave day frozen to a posted run → `LEAVE_DAY_PAID`. *Mutant: void ignores `frozen_by_pay_run_id`.*
20. Year-end: 3 unused SIL days × rate on 31 Dec in `sil_conversion_pay` of the run covering 31 Dec; second run pays nothing; voiding the run releases it. *Mutant: payout not idempotent.*
20a. Person with no attendance in the 31 Dec period still gets a slip with `days_worked = 0` and the payout. *Mutant: payout only rides on existing slips.*
20b. Two concurrent jobs: paid once, on the designated employment (earliest `started_on`) at its rate. *Mutant: paid per employment.*
20c. After the payout is frozen, approving a paid SIL day that year → `SIL_YEAR_CLOSED`. *Mutant: late approval double-counts.*
20d. Separated 30 Jun: `postSeparation` writes the row with `separation_id` and a journal line; the year-end run skips the person; `voidSeparation` releases the row and reverses the line. *Mutant: paid at both final pay and year end.*
20e. 13th month for a person with a SIL payout and leave pay equals the same person's 13th month without them. *Mutant: SIL payout or leave pay written into `basic_pay`.*
20f. Reset on 1 Jan: a person at the yearly cap on 31 Dec can take leave on 2 Jan. *Mutant: rolling 12-month window.*
20g. Maternity and paternity days add ₱0 to `leave_pay`. *Mutant: statutory kinds paid by the employer here.*
21. Migration: a payslip row breaking `gross = basic + ot + nd + holiday + leave + sil` is rejected; all 8 file purposes insert, a 9th string is rejected. *Mutant: identity not rewritten, or a T-434 purpose dropped.*
22. Note text visible to the person and a `manage_attendance` holder; a store-B manager and a colleague get no `note` key in loader data. *Mutant: loader returns note, UI hides it.*
23. Grid, list and CSV export contain no note; audit payloads contain no note text. *Mutant: note selected in list/audit.*
24. Every transition writes its audit row with actor, time, person, dates, kind; void needs a reason. *Mutant: audit skipped on void/reject, or void reason optional.*
25. Grid shows Paid/Unpaid badge per leave date and a clash flag when punches exist. *Mutant: badge not rendered.*
26. A half-day request → refused. *Mutant: portion field accepted.*
27. Manager attaches a cert: purpose `leave_document`, EXIF stripped, `linked_to` = request; a staff-role upload → refused. *Mutant: wrong purpose or capability check dropped.*
28. Deciding manager, a `view_leave_document` holder and an admin each get a link expiring in 60 s and a `viewed` audit row. *Mutant: view not audited, or the 300 s default used.*
29. A colleague, a store-B manager, a second store-A manager after another manager decided, and the employee each get only `hasProof: true`: no file id in loader data, no link. *Mutant: loader returns the id, UI hides it.*
30. A guessed `/files/<id>` for a `leave_document` by an unauthorised viewer → same 404 as a missing id, body names nothing, and a `view_refused` row survives the rollback. *Mutant: read falls through to `canReadFiles` (manage_attendance), or the refusal leaks existence.*
31. Grid, lists, CSV export and audit payloads carry no proof file id, path or URL. *Mutant: id selected in a list.*

## Ian's answers (2026-10-16) and orchestrator rulings

Q1 reset every 1 Jan for everyone · Q2 unused SIL paid out as cash through payroll (D11-12) · Q3
whole days only · Q4 managers attach medical-certificate photos, row-353 guarded (D14) · Q5 pro-rated
SIL in the anniversary year (D7; rounded up, from the anniversary; HR to confirm with DOLE) · Q6 no
self-approval except super_admin (D5). Opus review fixes 1-11 folded into D2-D16 (2026-10-16).
