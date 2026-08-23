# 15 — Capabilities Inventory: People (Discovery)

Domain: attendance/time clock, biometrics, shifts/schedules, overtime, payroll periods
and pay runs, pay rates/compensation, salary advances, statutory contributions,
staff records/positions, performance, memos, infractions, onboarding, leave, staff
cash accountability. Source: `C:\Users\ianla\webapps\ERP-rebuild` (read-only). This is
**not** a mechanics re-inventory — `docs/discovery/03-business-logic.md`,
`04-auth-and-permissions.md`, and `05-offline-and-biometrics.md` already mapped the
mechanics and are cited rather than repeated. This document answers, for each
capability: **what problem does this solve, and does the v2 plan (`PROJECT_BIBLE.md`
§10) have a home for it.**

Every v1 feature here exists because daily operations needed it (per Ian, `PROJECT_BIBLE.md`
§1.2b). Implementation quality is judged separately from whether the need is real.
All claims `[VERIFIED]` cite `file:line`; `INFERRED` claims are marked as such.

Phase names referenced below (bible §10): **P0** foundation/spike, **P1** accounting
spine, **P2** money-moving source documents, **P3** inventory, **P4** attendance +
biometrics + hot lane, **P5** payroll, **P6** reporting, **P7** peripheral modules
(admin, onboarding, memos, performance, checklists, cookbook), **P8** cutover.

---

## 1. Attendance & time clock

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Clock in/out via passcode, NFC/QR badge, fingerprint, or face | Lets a floor staffer who has no Firebase login start/end a paid shift at a shared terminal, with the method chosen per store (cost of hardware vs. speed vs. spoof-resistance) | Cashiers/cooks/servers at a shared clock terminal; managers configuring which methods a store allows | `attendance-clock.actions.ts` (`clockByPasscodeAction`, `clockByNfcAction`, `clockByFingerprintAction`, `clockByFaceAction`, `getAttendanceStateAction`) [VERIFIED, per `03-business-logic.md` group H] | **P4** — "Punch model, server-side adjudication" | DUPLICATE |
| Per-method kill switch, re-checked on every punch including replays | Lets a manager instantly disable a compromised or malfunctioning credential method store-wide without losing what's already queued | Store manager/admin | `assertMethodEnabled`, `attendance-clock.actions.ts:660` [VERIFIED, `05-offline-and-biometrics.md:134`] | **P4**, hot-set item 3 (bible §5.3 — explicitly a NEW cache addition, not a port) | DUPLICATE |
| Post-punch cooldown (accidental double-tap) | Stops one physical press registering as two punches | All clock-terminal users | `DEBOUNCE_MS=8000`, `attendance-clock.actions.ts:27`; `CLOCK_COOLDOWN_MS`, `:35` (display-only) [VERIFIED, `05-offline-and-biometrics.md:97,132`] | **P4** | CORRECT — v1's 5-min cooldown banner is UI-only, nothing server-side blocks a second punch beyond the 8s debounce (landmine class; `05-offline-and-biometrics.md:97`) |
| Throttle / brute-force lockout on passcode + face | Stops a hill-climbing attack guessing another staffer's passcode or hunting for a face match | System, transparent to legit users | `MISS_THRESHOLD=10`/`MISS_WINDOW_MS=60s`/`LOCK_COOLDOWN_MS=60s`, `attendance-clock.actions.ts:453-512` [VERIFIED] | **P4** | DUPLICATE |
| Missed clock-out sweep | Finds a staffer who clocked in and never clocked out (forgot, phone died, etc.) so a manager can settle the day instead of it silently sitting open forever | Manager (cleanup), payroll (can't pay an open session) | `attendance-sweep.actions.ts` `sweepStaleOpenSessionsAction` [VERIFIED, `03-business-logic.md:120`] | **P4** | DUPLICATE |
| On-shift roster + today's punch feed | Lets a manager see who is currently clocked in and what's happened today at a glance, without opening every staff record | Manager, floor supervisor | `listOnShiftRosterAction`, `listTodayClockFeedAction`, `attendance-clock.actions.ts` [VERIFIED, `03-business-logic.md:118`] | **P4**, hot-set item 4 | DUPLICATE |
| Break start/end, with only the over-allowance minutes deducted from pay | Staff get a paid break allowance; only the EXCESS over that allowance costs them pay — matches how the business actually compensates breaks | Staff (start/end), manager (void a mistaken entry) | `break-log.actions.ts` `startBreakAction:52`, `endBreakAction:140`, `voidBreakAction:195`; deduction logic `session-hours.ts` `applyBreakAndCaps:177-207` [VERIFIED] | **P4** (punch model) | CORRECT — v1 has **no offline path for breaks at all**; the offline UI omits the Break buttons entirely (`05-offline-and-biometrics.md:67`, landmine #14/#15 class). The capability (paid-allowance breaks) is sound; the "always-online" constraint is the flaw to fix, not a reason to drop it |
| Offline fingerprint clock-in with queue + reconcile-on-reconnect | Keeps a store clocking staff in/out through a network outage — the only credential method with a real offline path in v1 | Staff at a store with intermittent internet | Full mechanics already mapped in `05-offline-and-biometrics.md` §1-6 | **P4** — explicit hot-set (bible §5.3); v2 **replaces** v1's hand-rolled IndexedDB queue with the Firestore two-lane model (bible §5.2, decision #10) | DUPLICATE (need) / CORRECT (mechanism — v1's queue is bespoke and "partly wrong", landmine #16) |
| Manager Late / Next-in decision | When a staffer taps in off-schedule, lets a manager decide in one click whether to pay them from the scheduled start (docking nothing, marking late) or from the next allowed start (paying from when they actually began) — without a manual time edit | Manager/attendance-manager-flagged local user | `setAttendancePayrollInModeAction`, `attendance-review.actions.ts` [VERIFIED, `03-business-logic.md:119`]; decision arithmetic `shift-boundaries.ts` `resolveStartAnchor:203-284` | **P4** ("server-side adjudication") | DUPLICATE |
| Early-out approval | Lets a manager who sent someone home early (a slow shift) approve paying them to the scheduled end instead of docking the early departure | Manager | `setAttendanceEarlyOutApprovedAction`, `attendance-review.actions.ts` [VERIFIED, `03-business-logic.md:119`]; `workday.ts:44-48,111-112` | **P4** | DUPLICATE |
| Half-day override | Lets a manager mark a day as a half day when the automatic short-shift rule (below) shouldn't apply or needs correcting | Manager | `setAttendanceHalfDayAction`, `attendance-review.actions.ts` [VERIFIED] | **P4** | DUPLICATE |
| Session verify / void with audit trail | Lets a manager sign off on an attendance record as correct (locks it for payroll) or void a bad one, both leaving a trail | Manager/admin | `verifyAttendanceSessionAction`, `voidAttendanceSessionAction`, `attendance-review.actions.ts` [VERIFIED] | **P4** | DUPLICATE |
| Attendance-manager grant (non-manager can adjudicate) | Lets an admin deputize a trusted non-manager local user (e.g. a senior cashier) to resolve flagged attendance without promoting them to Firebase `manager` role | Admin (grants), deputized local user (uses) | `localUser.attendanceManager`, `local-user.actions.ts:200-205`; gate `attendance-access.ts:9-26` [VERIFIED, `04-auth-and-permissions.md:139-144`] | **P4** (implied — no explicit mention of this specific delegation grant) | DUPLICATE, but flag: not itself named in the phase description — confirm it survives |

---

## 2. Biometrics & credential provisioning

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Fingerprint enrollment (up to 2 fingers, on-device ZK9500 match) | Gives a staffer a clock-in credential that can't be forgotten, shared, or guessed, and needs no phone/card | Staff (enrolls), manager (initiates enrollment) | `attendance-fingerprint.actions.ts` `enrollFingerprintAction:69-74` [VERIFIED, `05-offline-and-biometrics.md:78`] | **P4**, hot-set item 2 | DUPLICATE |
| Face enrollment + 1:N match with blink liveness | Same need as fingerprint, for stores without USB reader hardware — camera-only | Staff, manager | `attendance-face.actions.ts`; match `face-core.ts:106-146` [VERIFIED] | **P4** — explicitly **excluded from the offline hot set permanently** (bible §5.3, decision #12) | DUPLICATE, online-only by design (carry the 2026-07-04 biometric-exfiltration fix forward, do not re-propose offline face) |
| NFC card / QR "Assign ID" badge enrollment | Gives stores a cheap, fast tap/scan credential when biometric hardware isn't installed | Manager (enrolls), staff (taps/scans) | `enrollNfcCardAction:205`, `generateAssignIdAction:253`, `attendance-payroll.actions.ts` [VERIFIED] | **P4** | DUPLICATE |
| 6-digit passcode clock-in, store-unique | Lowest-friction fallback credential requiring no hardware at all | Staff, manager (assigns/resets) | `local-user.actions.ts`, HMAC-secured (`project_attendance_login_pin_as_passcode`) | **P4** | CORRECT — the passcode-lookup HMAC secret fails **open** to a public fallback if unset in prod (`04-auth-and-permissions.md §7 gap 5`, landmine #20) |
| Passcode-conflict detection | Surfaces legacy duplicate passcodes across staff so a manager can fix a mis-routing risk before it causes a wrong clock-in | Manager/admin | `listPasscodeConflictsAction`, `local-user.actions.ts:77` [VERIFIED] | **P4** | DUPLICATE |
| Offline credential bundle (fingerprint templates + roster, TTL'd) | Lets a device that's flagged as a "clock station" keep matching/authorizing punches for up to 7 days with zero network | Registered clock-terminal device | `offline-clock.actions.ts` `getOfflineClockBundleAction`; `assembleOfflineBundle`, `bundle.ts:63-79` [VERIFIED, `05-offline-and-biometrics.md §2.1,§5`] | **P4**, hot-set item 2 | CORRECT — bible §5.3 tightens this: v1 gates the bundle to manager/admin-or-registered-terminal, but the **separate** `listFingerprintTemplatesAction` read is store-member gated (any authenticated store member), a wider exposure than the bundle itself (`05-offline-and-biometrics.md:96`) — v2 must scope the biometric mirror to a device identity only, never an ordinary staff/manager account (bible §5.3 "non-negotiable") |
| Clock-terminal device registration/revocation | Lets a manager designate which physical devices are trusted to hold an offline biometric bundle, and pull that trust instantly if a device is lost/stolen | Manager/admin | `registerClockTerminalAction`, `revokeClockTerminalAction`, `offline-clock.actions.ts` [VERIFIED, `03-business-logic.md:125`] | **P4** | CORRECT — v1 stores the device's `{id, secret}` in plaintext `localStorage` (`05-offline-and-biometrics.md:150`); bible §5.3 requires this NOT be plaintext in v2 |

---

## 3. Shift scheduling & the late/OT judgment engine

This is the highest-density business logic in the people domain — read `shift-boundaries.ts`,
`workday.ts`, and `session-hours.ts` in full before touching any of it in v2; the doc
comments in these three files carry more real business decisions than any other
attendance code.

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Demand-driven scheduling (no fixed per-person start) | Staff schedules follow forecasted demand/reservations, not a posted personal roster — so "late" cannot be computed against a static per-person expected start | Ops model underlying every attendance decision | `shift-boundaries.ts:472-490` — Ian's 2026-08-04 decision, explicitly re-affirmed and extended 2026-08-20 [VERIFIED] | **P4** | DUPLICATE — **do not build a per-staff scheduled-start field**; it was proposed and explicitly rejected once already (see "Intent worth preserving" below) |
| Span-based day judgment (pay by what was delivered, not when it began) | Judges a day's pay by the hours actually worked against the requirement, trying the next allowed start first and only falling back to "late against the previous start" when the span doesn't support it | System (every clock-out, every manager review) | `shift-boundaries.ts` `resolveStartAnchor:203-284` — Tier 1 (full day) / Tier 2 (half day) rule, invariant "moving the anchor forward never reduces guaranteed paid hours" (`:192-198`) [VERIFIED] | **P4** | DUPLICATE — this is the single most load-bearing rule in the module; see "Intent worth preserving" |
| One unified "what does this day pay" resolver | Prevents three previously-hand-duplicated computations (clock-out, manager review, Late/Next-in decision) from drifting apart, which had already caused two real bugs (short-shift OT silently dropped on a review edit; lateness not re-derived after a correction) | System (every code path that touches a session's hours) | `workday.ts:1-18` [VERIFIED] | **P4** | CORRECT-preserving — this is itself the fix for a v1 bug class; v2 must not reintroduce parallel computations |
| Inverted-window defense (C1 guard) | Stops an overlay combination (Late decision + Early-out approval) from producing a paid window whose end is before its start, which would let the pairer silently swap in/out and fabricate a fictitious shift | System | `workday.ts:126-165` [VERIFIED] | **P4** | DUPLICATE (defense-in-depth invariant, keep) |
| Grace-adjusted clock-out hour | Softens the "floor to the hour" truncation so sending someone home 15 minutes early doesn't cost them a full hour of pay | Store policy (configured), applies to every session | `graceAdjustedEndHour`, `shift-boundaries.ts:104-134`; config `earlyOutGraceMinutes`, `attendance-config.ts:83-95` (default 0) [VERIFIED] | **P4/P5** | DUPLICATE |
| Undertime grace | Forgives a small shortfall against required hours and credits the full shift anyway, applied BEFORE the short-shift rule so the two never fight over the same session | Store policy | `session-hours.ts:112-129`; config `undertimeGraceMinutes`, `attendance-config.ts:96-113` (default 0) [VERIFIED] | **P5** ("late/OT policy") | DUPLICATE |
| Short-shift half-day + pending-OT rule | A shift under the required hours is credited as a half day for the first N hours (default 5), and the REMAINDER is raised as a pending, approval-gated overtime record rather than either being lost or auto-paid | Store policy (opt-in `shortShiftHalfDayOt`) | `session-hours.ts:131-144`; raises via `pending-ot.ts` `raiseShortShiftOt:45-109` [VERIFIED] | **P5** | DUPLICATE |
| "Is this decision even worth asking a manager" gate | Only prompts a manager for a Late/Next-in call when the answer would actually change money — 52% of flagged days measured at one branch were already full shifts either way, so asking would have been noise | Manager (fewer, more meaningful prompts) | `isStartDecisionMaterial`, `shift-boundaries.ts:492-507` [VERIFIED] | **P4** | DUPLICATE — a real UX/ops-load finding worth preserving even in a redesigned UI |
| Night-differential premium hours | Tracks hours worked inside a configurable night window (default 22:00–06:00) for premium pay — used to be hardcoded while the settings UI lied about controlling it | Store policy, payroll | `nightDiffHoursInWindow`, `session-hours.ts:35-44`; config `nightDiffStartHour/EndHour`, `attendance-config.ts:37-38,178-179` [VERIFIED] | **P5** | DUPLICATE |
| Holiday-pay premium hours | Flags a session as falling on a PH holiday so the shift can be paid at the statutory premium | Payroll | `session-hours.ts:161`; lookup table `ph-holidays.ts` (not read in depth) [VERIFIED partial / lookup table INFERRED contents] | **P5** | DUPLICATE |
| Fixed-mode shift templates vs. open "allowed start hours" mode | Lets a store run either a posted half-hour shift grid or a looser "any of these hours is a legitimate start" model, per its own operating style | Manager configures; system applies at every clock-in | `resolveScheduleAnchors`, `shift-boundaries.ts:328-405` — fixed mode uses `shifts[]`, open mode uses `allowedShiftStartHours` [VERIFIED] | **P4** | DUPLICATE — flag: fixed mode's `shifts[]` grid and open mode's `allowedShiftStartHours` are a genuinely different grid and can disagree; documented as dormant (no store runs fixed mode) but not removed |
| Half-hour OT display rounding | Gives managers a glance-friendly OT summary (25+ minutes into a half-hour block rounds up) on the review table, separate from the precise figure actually filed | Manager (reading the table) | `ot-rounding.ts:1-24` — explicitly **display-only**, does not change what gets filed [VERIFIED] | **P5** (reporting surface) | DUPLICATE |

---

## 4. Overtime

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Manual OT filing + approve/reject/void | Lets a manager record overtime that isn't auto-raised (e.g. a planned late shift) and put it through an approval gate before it pays | Manager | `overtime.actions.ts` `saveOvertimeAction`, `approveOvertimeAction`, `rejectOvertimeAction`, `voidApprovedOvertimeAction` [VERIFIED, `03-business-logic.md:111`] | **P5** ("late/OT policy") | DUPLICATE |
| Self-approval block on OT | Stops a manager approving their OWN overtime — reject/void are deliberately left open since they only move pay DOWN | Segregation-of-duties control | `overtime.actions.ts:93-149` [VERIFIED, `03-business-logic.md §2.9`] | **P5** | DUPLICATE — this is a control to preserve exactly, not merely a feature |
| One active OT record per staffer/day | Stops the same day's overtime being filed twice through two different paths (manual entry + attendance-review auto-raise) and both getting approved, paying it twice | System | `overtime-guard.ts` `findActiveOvertimeForDay:22-37` [VERIFIED] | **P5** | DUPLICATE — this is the concrete fix for a realistic double-pay bug; keep the invariant even if the storage model changes |
| Auto-raised short-shift OT (pending, approval-gated) | See §3 — the remainder above the half-day credit is filed automatically so correcting a short shift never silently cuts pay by the uncredited remainder | System (clock-out and manager-review paths both raise the SAME record shape) | `pending-ot.ts` `raiseShortShiftOt:45-109`, `voidShortShiftOt:152-172` [VERIFIED] | **P5** | DUPLICATE |
| Auto-raised late-out OT | Files a pending OT record when a staffer clocks out AFTER the scheduled end (excess time is capped away from `computedHours`, never auto-paid) | Manager (files from attendance review) | `pending-ot.ts` `raiseLateOutOt:207-247` | **P5** | DUPLICATE |

---

## 5. Payroll periods, pay runs & compensation

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Period preview (cached aggregation) | Lets a manager see what a pay period will cost BEFORE committing, without re-scanning ~375 reads / 3.6s of Firestore every time the page opens | Manager/admin | `payroll.actions.ts` `previewPayrollPeriodAction:387`, cache-vs-refresh model documented `:374-386` [VERIFIED] | **P5** ("periods") | DUPLICATE |
| Per-staff pay run (not whole-period post) | Pays ONE staffer at a time, funded by a manager-chosen split of accounts, rather than posting an entire period as one lump against one account — lets a manager pay whoever is ready without waiting on stragglers | Manager or admin | `payroll-staff-payout.actions.ts` `payStaffPayrollAction`; whole-period post was **removed** in a 2026-08 refactor (Task 10) [VERIFIED, `03-business-logic.md:104`] | **P5** ("immutable pay runs") | DUPLICATE |
| Deterministic payout doc id (double-pay guard) | Two concurrent "Pay this staff" clicks cannot both post — no lock doc, no read-then-write race to lose | System | `staffPayoutId`, `payroll/staff-payout.ts:7-15` [VERIFIED] | **P5** | DUPLICATE |
| Payment-split validation (no cashier drawer, one line per account, exact total) | Stops payroll being funded from the cashier's daily drawer (which would never reconcile against the cashier's own remittance), stops two split lines silently colliding on one account, and stops a split total drifting from net pay by even a centavo | System, at the point a manager funds a payout | `validatePaymentSplits`, `staff-payout.ts:25-96` [VERIFIED] | **P5** | DUPLICATE — dense, hard-won validation; preserve every branch, not just the happy path |
| Period-lock after payout ("paid-guard") | Once a staffer is paid for a period, refuses any later edit to their attendance/deductions for that period — a frozen payslip and live inputs must never be allowed to disagree | System, protects payroll integrity | `paid-guard.server.ts` `assertStaffNotPaidForPeriod:39-49` [VERIFIED] | **P5** | DUPLICATE — this is exactly the kind of "immutable pay run" the phase promises |
| Double-pay guard by period OVERLAP, not exact bounds | Stops a config change to the pay-period cutoffs (e.g. semi-monthly 15/31→15/30) from re-deriving a different id for already-paid days and letting a second real cash payment go out | System | `paid-guard.server.ts` `assertStaffPeriodNotAlreadyPaid:69-85`; fixed in "round 2/5" after being found live [VERIFIED] | **P5** | DUPLICATE — this closed a real production bug; the overlap-not-equality design decision must survive |
| Void-order discipline (expense before payout, or vice versa) | The salaries-payable liability must always be able to reach exactly zero; voiding a payout while its period's lump-sum expense is still posted (or paying after the expense is recorded) would strand the liability non-zero forever with nothing able to clear it | System, surfaced to manager as a specific refusal reason | `payoutVoidBlockedReason`/`payBlockedByRecordedExpenseReason`, `staff-payout.ts:142-196` [VERIFIED] | **P5** | DUPLICATE |
| Zero-gross-pay refusal | Stops "paying" a staffer whose sessions are all still `needs_review` (gross = ₱0) — that used to write a payout doc with NO journal legs and lock the period against the very edits needed to fix it | System | `staff-payout.ts` `zeroGrossPayBlockedReason:213-220` [VERIFIED] | **P5** | DUPLICATE — closes a specific found bug (round 2/5) |
| "Everyone must be paid before the period total is recorded" gate | Stops a partial lump-sum salaries expense from understating cost and leaving a residue nothing later clears | Manager, at period close | `staff-payout.ts` `unpaidStaffBlockedReason:239-248` | **P5** | DUPLICATE |
| Effective-dated pay rate with history | Changes to a staffer's hourly/daily rate are versioned, never overwritten, so a past payslip can be reconstructed against the rate that was actually in force | Manager/admin (self-dealing blocked — see §7) | `updateStaffHourlyRateAction`, `attendance-payroll.actions.ts:475`; `staff/{id}/hourlyRateHistory` [VERIFIED, `03-business-logic.md:123`] | **P5** — "effective-dated compensation" is named explicitly in the phase deliverable | DUPLICATE |
| Non-rate payroll fields (pay type, frequency, etc.) | Separates "how this person is compensated" config from the rate itself, editable without touching the rate-history audit trail | Manager/admin | `updateStaffPayrollAction`, `attendance-payroll.actions.ts:433` [VERIFIED] | **P5** | DUPLICATE |
| Payroll additions (allowances/bonuses), single shared account | Lets a store give a staffer a recurring or one-off addition without needing a per-addition GL account decision — everything posts to one shared additions account | Manager | `payroll-addition.actions.ts` (6 exports, `:46-289`) [VERIFIED] | **P5** | DUPLICATE |
| Payroll deductions with a keep/remit fork | Distinguishes a deduction the STORE keeps (e.g. a uniform charge) from one that must be REMITTED to a third party (e.g. an SSS salary loan) — a remittable deduction requires a liability account key so the obligation to pay it forward is tracked, not just subtracted from pay | Manager/admin | `payroll-deduction.actions.ts:92-97` [VERIFIED] | **P5** | DUPLICATE — the remit-side liability tracking is exactly what bible decision #49 (statutory subledger) extends |
| Bulk-assign an addition/deduction to many staff at once | Lets a manager tag a whole roster (e.g. "everyone gets the new uniform charge") in one action instead of one staffer at a time, without resetting a balance already partway paid | Manager | `bulkAssignStaffPayrollAdditionAction`, `payroll-addition.actions.ts:222` [VERIFIED] | **P5** | DUPLICATE |
| Per-piece "slicer" pay (a second compensation stream) | Pays a meat slicer per-piece from posted production/slicing records — a genuinely different pay model from hourly/daily payroll, coexisting for the same person | Manager/admin, slicer staff | `staff-payment.actions.ts` (Slicer Payment), header `:1-29` — parks gross as a liability exactly like `payStaffPayrollAction`, recognized once via the period lump sum [VERIFIED] | **P5** — not named explicitly, but is a compensation stream that must post through the same liability | DUPLICATE — flag: confirm this survives as its own pay type, not silently folded into hourly |
| Statutory contributions (SSS / PhilHealth / Pag-IBIG, employee share) | Computes the legally mandated employee-share deductions from the real PH bracket/MSC tables, scaled from a period to a monthly-equivalent | System, every payroll computation | `payroll/statutory.ts:26-196` — SSS 4.5% of MSC (floor ₱4,000/ceiling ₱30,000, `:40-51`), PhilHealth 2.5% (floor ₱10,000/ceiling ₱100,000, `:54-64`), Pag-IBIG 1%/2% split at ₱1,500, capped ₱200 (`:66-77`) [VERIFIED] | **P5** — bible decision #30: "PH statutory rates are effective-dated data in one module, never inline constants" | DUPLICATE (need) / CORRECT (v1 hardcodes the rates as constants tagged `TAX_TABLE_VERSION='PH-2024'` with a "REVIEW ANNUALLY" comment, `statutory.ts:1-28` — v2 must make these effective-dated data, not code) |
| Withholding tax (BIR graduated tables, per pay frequency) | Computes statutory income tax withholding using the BIR-sanctioned per-payroll-frequency method, exact per period | System | `computeWithholding`, `statutory.ts:79-119` [VERIFIED] | **P5** | Same as above — CORRECT (move off hardcoded constants) |
| Deductions capped so pay can never go negative | If SSS+PhilHealth+Pag-IBIG (independently rounded) would exceed the period's gross, scales all three down proportionally and absorbs any rounding residue into the largest line, so the total is exactly ≤ gross AND the displayed lines sum exactly to it | System | `computePeriodStatutory`, `statutory.ts:146-196` [VERIFIED, also `03-business-logic.md §2.18`] | **P5** | DUPLICATE — a genuinely hard-won correctness rule, preserve exactly |
| **13th month pay** | PH statutory requirement for rank-and-file employees | — | **NOT FOUND.** No file, constant, or action anywhere under `src/lib/payroll`, `src/lib/actions/payroll*`, or `src/lib/actions/staff*` computes or tracks a 13th-month accrual or payout [VERIFIED absence by search] | **NOT PLANNED** — not named in any phase | **ASK IAN** — is this computed manually outside the system today, or genuinely missing? See "Capabilities with no home in the plan" |
| **Separation / final-pay / clearance workflow** | Settling a terminated/resigned staffer's last pay, any outstanding advances, and closing their record cleanly | — | **NOT FOUND as a distinct workflow.** `EmploymentStatus` includes `resigned`/`terminated` (`staff.actions.ts:28`) and a comment acknowledges "pay a staffer their final pay, mark them terminated" as an ORDER dependency to protect (`payroll-staff-payout.actions.ts:169-173`), but there is no dedicated clearance/final-pay/separation-pay action or computation [VERIFIED absence by search] | **NOT PLANNED** | **ASK IAN** — same question: handled manually today, or a real gap? |

---

## 6. Salary advances

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Grant / repay a salary advance | Lets the business front a staffer money against future pay and track the running balance | Manager/admin | `salary-advance.actions.ts` `upsertSalaryAdvance:114`, `voidSalaryAdvance:756` [VERIFIED] | **P5** — "salary advances" named explicitly | DUPLICATE |
| Self-dealing block on advance/repayment (not on charge) | A non-admin cannot record their OWN salary advance or repayment (a benefit to themselves); a `charge` transaction is deliberately NOT blocked because it increases the staffer's OWN debt, not their benefit | Segregation-of-duties control | `salary-advance.actions.ts:226-241` [VERIFIED, `03-business-logic.md §2.9`] | **P5** | DUPLICATE — preserve the asymmetry (advance/repay blocked, charge exempt), not just "block self-dealing" generically |
| Zero-balance / write-off | Lets a manager close out a small remaining balance in one step rather than tracking a residual centavo forever | Manager/admin | `zeroBalanceSalaryAdvanceAction`, `salary-advance.actions.ts:927` [VERIFIED] | **P5** | DUPLICATE |
| Journal-vs-balance inspection & recompute-from-truth | Lets an admin see exactly which journal legs back a staffer's advance balance, and rebuild the balance projection from that journal truth if it ever drifts | Admin | `inspectSalaryAdvanceStaffJournalAction:1016`, `recomputeSalaryAdvanceStaffAction:1203` [VERIFIED] | **P5** | DUPLICATE |
| Cross-store centralized ledger (view-all, edit-own) | A staffer who works multiple branches has ONE real debt to the business, not one silo per store — lets a viewer see every linked store's balance while write access still respects per-store permissions | Manager/admin overseeing multi-branch staff | `getStaffCrossStoreLedgerAction`, `salary-advance.actions.ts:1292`; identity link via `staffIdentities` [VERIFIED, `03-business-logic.md:108`, `04-auth-and-permissions.md §1.4`] | **P5** | DUPLICATE |
| Per-store advance policy settings | Lets each store set its own salary-advance rules (limits, terms) rather than a single global policy | Manager/admin | `salary-advance-settings.actions.ts` `upsertSalaryAdvanceSettings:15` [VERIFIED] | **P5** | DUPLICATE |

---

## 7. Staff cash accountability

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Cash request → approve → release → return/liquidate lifecycle | Lets a staffer be advanced a cash float for a purchase/errand and tracks it through to being accounted for (spent + receipted, or returned) | Staff (requests), manager (approves/releases) | `cash-requests.actions.ts:35-256`, `release-cash-request.actions.ts`, `return-cash-request.actions.ts` [VERIFIED, `03-business-logic.md group E`] | **P2** — "cash requests" named explicitly | DUPLICATE |
| Self-approval block on cash requests | A requester cannot approve their own request even as a manager — admin override only | Segregation-of-duties control | `policy.ts:47-56` [VERIFIED, `03-business-logic.md §2.9`] | **P2** | DUPLICATE |
| Unliquidated shortage → staff charge | Converts a cash float that wasn't fully accounted for into a formal charge against the staffer (via the salary-advance `charge` txType, which is deliberately NOT self-dealing-blocked since it only increases their own debt) | Manager/admin | `charge-cash-request-shortage.actions.ts` [VERIFIED, `03-business-logic.md:82`] | **P2/P5** boundary | DUPLICATE |
| Cash-request coverage for an unremitted cashier shortfall | Lets an existing cash-request float absorb a cashier's shortfall instead of raising a brand-new charge for the same money problem | Manager | `sales-coverage.actions.ts` `applyCashRequestCoverageAction` [VERIFIED, `03-business-logic.md:25`] | **P2** | DUPLICATE |
| Reimbursement payout (business owes staff) | Nets down what the business owes a staffer who paid out-of-pocket for a business need — the mirror direction of a cash request | Manager/admin | `reimbursement.actions.ts` `recordReimbursementPayoutAction:51` — pays against a `staff_reimbursable__{staffId}` liability [VERIFIED] | Not explicitly named in any phase (the underlying liability is created via an expense's `reimbursable` payment split, which is **P2**) | DUPLICATE, but flag: the PAYOUT half of this isn't itself named — confirm it rides along with P2's expense/AP work, not dropped |
| Wastage staff-charge (cross-reference) | A staff-caused wastage can become a charge via the same salary-advance `charge` mechanism | Manager/admin | `wastage.actions.ts` `setWastageResponsibilityAction` [VERIFIED, `03-business-logic.md group N`] | **P3** (inventory) triggers a **P5** (payroll) side effect | DUPLICATE — cross-domain dependency worth flagging at the seam |

---

## 8. Staff records, positions & identity

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Staff master record (HR/payroll identity) | Holds who someone is for HR/payroll purposes: pay rate, position, employment status, staff code — independent of whether they have a Firebase login or a local-user PIN | Manager/admin | `staff.actions.ts` `upsertStaff:36`; `EmploymentStatus` enum (`regular/probationary/contractual/part-time/resigned/terminated/inactive`, `:28`) [VERIFIED] | **Not named in any phase.** Implicitly required by P4 (attendance) and P5 (payroll) but has no phase of its own | See "Capabilities with no home in the plan" — flag |
| `staff.active` derived, not directly toggled | The dashboard's active-staff count must always equal `count(staff where isActive==true)` — treated as a projection invariant, not a field a form can drift from | System | `activeStaffCountDelta`, `financial/staff/active-staff-count.ts:1-56`; project memory `project_staff_active_status_derived` [VERIFIED] | Same as above | Preserve the invariant regardless of where it lands |
| Hand-drawn signature capture, append-only history | Captures a staffer's signature on a manager's device for later use on memos, keeping every prior signature (never overwritten) so an old memo's signature can't be silently altered | Manager (captures), staff (used later for memo ack) | `saveStaffSignatureAction`, `staff.actions.ts:314` [VERIFIED] | **P7** ("memos") uses this; not named on its own | DUPLICATE |
| Link a Firebase account to a staff record | Lets the system recognize when a manager/admin's own Firebase account IS a given staff record — the identity fact every self-dealing block (rate change, overtime approval, salary advance) depends on | Admin | `setStaffLinkedUserAction`, `staff.actions.ts:357`; enforced 1:1 | **P0/§7.1** — the "person spine" decision (#14) targets exactly this identity mess | CORRECT — v1's self-check resolution (`resolveActorOwnStaffIds`) is duplicated per-file and depends on an email-match fallback because a shared-device actor's Firebase uid isn't the individual (`03-business-logic.md §2.20`) — this is precisely the identity gap bible §7.1 commits to closing |
| Cross-store person identity (`staffIdentities`) | Links one real person's per-store staff records so a cross-store salary-advance balance (or memo/perf tracking) can find all of them | Admin (manually links) | `staff-identity.actions.ts` `upsertStaffIdentityAction:15`, `rebuildStaffIdentityBalanceAction:111` [VERIFIED] | **P0/§7.1** person spine should subsume this | CORRECT — v1's version is manually admin-linked, not automatically derived (`04-auth-and-permissions.md:77-80`) |
| Position taxonomy (canonical + store-defined) | Gives every local user an operational role (Cashier/Cook/Server/Dishwasher/Slicer/Inventory Staff, plus store extras) used for permission gates, distinct from the Firebase admin/manager/staff role | Manager/admin configures; used everywhere a position-gated permission exists | `position.actions.ts` `listPositionsAction:61`, `upsertPositionAction:95`; canonical vocabulary `types/position.ts:73` [VERIFIED, `04-auth-and-permissions.md §2.3`] | Not named in any phase | Flag — see "Capabilities with no home in the plan" |
| Local-user (shared-terminal PIN identity) management | Creates/edits the PIN-login identity floor staff actually use day to day — separate from a Firebase account, since most cashiers never sign in with email/password | Manager (creates/manages), staff (self-registers pending activation, resets own PIN) | `local-user.actions.ts` (11 exports, `:40-561`) [VERIFIED, `04-auth-and-permissions.md §1.2`] | **P4** (clock terminal identity), but the identity-verification FIX (server-issued session token) is **P0/§7.1** | CORRECT — this is the file at the center of landmine #17: `LocalActor` is a client-supplied parameter on ~24 server actions with no server-verified session behind it (`04-auth-and-permissions.md §7 gap 1`) |
| Position permission gates (e.g. cashier 48-hour self-edit window) | Grants a narrow, time-boxed self-service capability (editing an expense they created) to a specific position without a blanket permission | System, enforced per-action | `policy.ts:80-90` [VERIFIED, `03-business-logic.md §2.11`] | **P4/P7** boundary | DUPLICATE |

---

## 9. Performance, infractions & discipline

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Monthly performance score (rebuild + live) | Rolls up attendance + sales attribution + infractions into one comparable monthly figure per staffer, with a public leaderboard view and a private sensitive breakdown | Manager/admin (full), staff (their own score only) | `staff-perf.actions.ts` `rebuildStaffPerfMonthAction:54`, `getStaffPerfDetailAction:281` — "positive public, sensitive private" split (`:3-9`) [VERIFIED] | **P7** — "performance" named explicitly | DUPLICATE — known open blocker: shift-report attribution (per project memory `project_performance_page`) — carry the blocker forward, don't silently drop the attribution requirement |
| POS↔ERP staff sales-attribution mapping | Lets a staffer's POS-recorded sales be attributed to their performance score | Manager/admin | `getPosMappingDataAction:92`, `setStaffPosProfileAction:138`, `staff-perf.actions.ts` [VERIFIED] | **P7**, dependent on the POS integration seam (bible §CROSS-APP-MAP) | DUPLICATE |
| Infraction catalog + manual filing/void | Lets a manager define violation types (with a point value 1-10) and file/void a disciplinary record against a staffer, always leaving an audit trail | Manager | `infractions.actions.ts` `upsertInfractionType:69`, `upsertStaffInfraction:165`, `voidStaffInfraction:320` [VERIFIED] | **Not named in any phase.** Feeds P7's performance score and P5's late policy but has no phase of its own | Flag — see "Capabilities with no home in the plan" |
| Auto-filed "Absent Without Notice" infraction | Automatically logs a no-show/no-call absence as a disciplinary record so it isn't lost to memory, without a manager having to remember to file it | System (auto), manager (can archive the type to disable, or void the record) | `operations/auto-infraction.ts` `autoLogAbsentNoShow:323-373`; seeded type `SYS_ABSENT_NO_NOTICE`, 5 points, `:23-29` [VERIFIED] | Same as above | Flag |
| Auto-filed "Late Arrival" infraction (points-only path) | When a store's late policy is set to `infraction` (not a pay deduction), files a points-only disciplinary record instead of docking pay — mutually exclusive with the money policy by config | System, gated by store `latePolicy` config | `auto-infraction.ts` `logLateInfraction:246-300`; `SYS_LATE`, 1 point default, overridden by store's `lateInfractionPoints` [VERIFIED, `attendance-config.ts:78-115`] | **P5** (late policy) + infractions gap above | Flag — this ties directly into P5's named "late policy," so it should NOT fall through the infractions gap; confirm explicitly |
| Missed daily-report infraction (checklist/usage) | Attributes a missing required daily report (checklist or stock-usage) to the staffer responsible, from the manager's morning briefing gate — a system finding knows WHAT is missing but not WHO, so a manager attributes it | Manager | `missed-report-infraction.actions.ts` `fileMissedReportInfractionAction:32`, `excuseMissedReportAction:121`; auto-seeded types `auto-infraction.ts:68-86` [VERIFIED] | **P7** ("checklists" named explicitly) | DUPLICATE |
| Channel-settlement discrepancy infraction | Traces a Grab/FoodPanda settlement-day AR variance beyond tolerance back to the cashier who filed the sales report and/or the manager who verified it, and lets a manager file a disciplinary record — always manager-initiated, never auto-filed, since it's a real disciplinary action | Manager | `channel-settlement-discrepancy-infraction.actions.ts` `planChannelSettlementDiscrepanciesAction:118` (preview first), `fileChannelSettlementDiscrepancyInfractionAction:243` [VERIFIED] | **P2** (channel settlement) triggers a people-domain side effect | DUPLICATE — cross-domain seam, preview-before-posting pattern worth preserving |
| Manager-gated infraction reads | The whole roster's disciplinary record is sensitive; two narrow read actions are the ONLY path so the underlying collection doesn't need to stay readable by every store member via the wildcard rule | System (closes an access-control hole) | `infractions.actions.ts:378-419` — explicit comment on why these two actions exist | **P7 + §7 rule 10** (field-level authorization) | CORRECT-preserving — this is a fix already made in v1; v2's row/column-level authorization (bible §7 rule 10) should make the pattern unnecessary rather than reinventing it per-collection |

---

## 10. Memos

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Draft → submit → approve/reject memo lifecycle | Gives management a formal, auditable way to issue a policy/notice that requires proof of delivery, not just a group chat message | Manager (authors), admin (approves) | `memo.actions.ts` `createMemoDraftAction:95`...`approveMemoAction:375` [VERIFIED] | **P7** — "memos" named explicitly | DUPLICATE |
| Frozen audience roster at approval + per-staff acknowledgment | Snapshots exactly who the memo targets at the moment it's approved, so "who still needs to sign" is well-defined even as staff join/leave later | System, manager (tracks completion) | `approveMemoAction:371-445` [VERIFIED] | **P7** | DUPLICATE |
| Roster reconciliation (excuse departed staff, restore returning staff) | Stops a memo being permanently stuck "incomplete" because someone on the frozen roster was deactivated, while never touching a real signed/rejected response | Manager ("Refresh roster"), system (once/day auto) | `reconcileMemoRosterAction:457-529` — bounded to once/day unless forced [VERIFIED] | **P7** | DUPLICATE |
| Kiosk signature capture (draw fresh, or attach saved signature via passcode) | Lets a staffer acknowledge a memo at a shared terminal without a personal device — either draws a signature on the spot or authorizes reusing their saved one by proving their own passcode | Staff, at a shared kiosk | `recordMemoSignatureAction:547`, `attachSavedSignatureToMemoAction:609` — passcode verification and the saved image both stay server-side [VERIFIED] | **P7** | DUPLICATE |
| Rejection recording + resolve/ack-status | Lets a staffer formally decline to sign (with a reason) rather than being forced through a false acknowledgment | Staff, manager (sees rejections) | `recordMemoRejectionAction:708`, `resolveMemoAckAction:760` [VERIFIED] | **P7** | DUPLICATE |
| Attached document (PDF/Word), draft-only, replace-and-clean-up | Lets a memo carry a formal attached document; locks it once approved (so what staff sign can't change after the fact) and deletes the superseded file so orphans don't accumulate in Storage | Manager (drafts) | `attachMemoDocumentAction:237` [VERIFIED] | **P7** | DUPLICATE |

---

## 11. Onboarding (training docs & exams)

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Training document lifecycle (draft/publish/reject/archive) + manager-proposed edits | Gives the business a controlled way to publish onboarding material, with a review gate before it goes live, and lets a manager suggest an edit without directly overwriting admin-owned content | Admin (owns), manager (proposes edits) | `onboarding.actions.ts` `upsertOnboardingDocAction:73`...`proposeOnboardingDocEditAction:318` [VERIFIED] | **P7** — "onboarding" named explicitly | DUPLICATE |
| Exam authoring + publish/reject/archive, manager-proposed edits | Same review-gated lifecycle as docs, for a knowledge-check exam attached to onboarding material | Admin, manager | `upsertOnboardingExamAction:418`...`proposeOnboardingExamEditAction:635` [VERIFIED] | **P7** | DUPLICATE |
| Staff view/acknowledge tracking | Records that a staffer actually opened and acknowledged a required document, so completion is provable, not assumed | Staff, manager (audits) | `recordOnboardingViewAction:733`, `acknowledgeOnboardingDocAction:784` [VERIFIED] | **P7** | DUPLICATE |
| Exam submission + manager grading for open-ended answers | Lets a staffer take a required exam and a manager grade the parts that can't be auto-scored (open-ended answers), closing the loop on "did they actually learn this" | Staff (submits), manager (grades) | `submitOnboardingExamAction:841`, `listOnboardingPendingReviewAction:974`, `gradeOnboardingExamSubmissionAction:1000` [VERIFIED] | **P7** | DUPLICATE |
| Progress dashboard (per-staff, admin-wide) | Lets a manager/admin see who has and hasn't completed required onboarding, store-wide or org-wide | Manager, admin | `listOnboardingProgressAction:1149`, `listOnboardingAllForAdminAction:1181` [VERIFIED] | **P7** | DUPLICATE |

---

## 12. Admin-level people controls

| Capability | What problem it solves | Who uses it | Where in v1 | In the ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Admin PIN (second factor for sensitive admin actions) | Adds a second, separate credential (distinct from a local-user PIN) that must be verified before an especially sensitive admin action proceeds | Admin | `admin-pin.actions.ts` `setAdminPinAction:32`, `verifyAdminPinAction:71` — PBKDF2 210,000 iterations, replacing an older SHA-256 scheme whose fields are explicitly deleted on rotation [VERIFIED, `04-auth-and-permissions.md §5`] | **P7** ("admin") | CORRECT — a verified PIN mints a 15-minute session recorded under `users/{uid}/adminSessions`, but no confirmed consumer of that session id was found anywhere in this codebase pass; it may be advisory-only in v1 (`04-auth-and-permissions.md:398-401,515-517`) — v2 must either wire real enforcement or not claim the protection exists |
| Firebase-Auth user approval lifecycle | Every new signup lands `pending` until an admin approves — stops an unvetted account from touching anything | Admin | `user.actions.ts` `updateUserProfileAction:32-99`, "last active admin" guard blocking the only admin's own demotion/deactivation `:51-61,126-135,204-213` [VERIFIED, `04-auth-and-permissions.md §1.5`] | **P0** (auth bridge) + **P7** (admin) | DUPLICATE — the "last active admin" lockout guard is a real incident-prevention control (`project_signup_admin_self_demotion`), preserve it explicitly |

---

## Capabilities with no home in the plan

Every row below is genuinely **NOT PLANNED** — not merely under a differently-named
phase. Ordered by what breaks operationally if each is never built in v2.

1. **Staff master record (HR identity: pay rate, position, employment status, staff
   code) has no phase of its own.** It's silently assumed to exist by P4
   (attendance needs a `staffId` to punch against) and P5 (payroll needs a rate to
   pay). If it's never explicitly scoped as its own deliverable, the risk is it gets
   built piecemeal inside P4/P5 without ever getting the "one `person` table" spine
   treatment bible §7.1/decision #14 already commits to — recreating exactly the
   four-loosely-linked-identities mess (`04-auth-and-permissions.md §1`) v2 is
   supposed to fix. **What breaks if skipped:** no clean place to attach pay rate,
   employment status, or the self-dealing identity checks every payroll/overtime/
   salary-advance approval depends on.

2. **Position taxonomy (Cashier/Cook/Server/Dishwasher/Slicer/Inventory
   Staff + store-defined extras) has no phase.** Every position-gated permission in
   the app (the cashier 48-hour expense-edit window, attendance-manager delegation,
   position-based nav) reads this. **What breaks if skipped:** either every
   permission gate hardcodes position strings again, or a store loses the ability to
   define its own extra positions.

3. **Infractions/discipline module has no phase.** It's used BY P7's performance
   score and BY P5's `latePolicy: 'infraction'` path, but the catalog + filing +
   void + audit-gated reads (`infractions.actions.ts`) are never themselves named.
   **What breaks if skipped:** a store that runs its late policy on points (not
   money) has nowhere to file to; performance scoring has no infraction input;
   channel-settlement and missed-report discipline lose their target collection.

4. **Absentee/leave tracking (no-show, sick, personal, emergency, with independent
   monthly and yearly caps per reason) has no phase at all.** This is the closest
   thing v1 has to a "leave" feature named in this discovery's domain brief, and it
   is entirely absent from the phase list — not folded into P4 (attendance), not
   into P7. **What breaks if skipped:** managers lose the ability to record and cap
   sick/personal/emergency absences, the auto-filed "Absent Without Notice"
   infraction loses its trigger, and there is no record at all of planned/approved
   leave versus a true no-show.

5. **13th month pay — not found in v1, and not planned in v2.** This is a Philippine
   statutory requirement for rank-and-file employees. Either it is computed
   entirely outside this system today (spreadsheet, accountant, manual bank
   transfer) or it is a genuine compliance gap in the live business. Either way,
   v2's phase list has no line for it. **Ask Ian before Phase 5 is scoped in
   detail** — this is exactly the kind of correctness gap the project's stated
   purpose (§1.1) exists to close, and it's cheaper to add a chart-of-accounts line
   and an accrual now than to retrofit one after cutover.

6. **Separation / final-pay / clearance workflow — not found in v1, not planned in
   v2.** `EmploymentStatus` has `resigned`/`terminated` values and one comment
   acknowledges the "pay final pay, then mark terminated" ordering matters, but
   there is no dedicated clearance action (last-day accrued pay, outstanding
   salary-advance settlement, unreturned cash-request float, exit checklist).
   **Ask Ian** whether this happens manually today.

7. **Reimbursement payout is not itself named**, only implied by P2's "expenses."
   The liability it clears (`staff_reimbursable__{staffId}`) is explicitly a
   people-domain balance (bible decision #42: reclassified as a genuine liability,
   "we owe to staff"). Confirm the payout action rides along with P2 rather than
   being dropped as "just an expense detail."

8. **Slicer per-piece pay is not named as its own compensation stream.** It shares
   plumbing with hourly payroll (same liability account, same period lump-sum
   recognition) but is a structurally different pay model. If P5 is scoped only
   against "periods, effective-dated compensation, late/OT policy, salary
   advances, immutable pay runs" without an explicit line for a second pay-basis
   stream, it risks being silently dropped or wrongly merged into hourly rate.

---

## Intent worth preserving

Business rules that would be lost if v2 were built from a schema/spec alone,
without reading the v1 code's comments.

1. **Lateness is not computable against a fixed per-person schedule, by explicit
   management decision — and this was already tried and rejected once.**
   `shift-boundaries.ts:472-490` (`isStartDecisionMaterial`'s doc comment) records
   that a static `staff.scheduledStartHour` field was **proposed and rejected by
   Ian on 2026-08-04**: staff schedules rotate with forecasted demand and
   reservations, so a fixed per-person expected start would be wrong on most days —
   "it would not remove false lateness, it would manufacture a more confident kind
   of it." **Do not re-propose a per-staff scheduled-start field in v2.** The
   correct model (re-affirmed and extended 2026-08-20) judges a day by what it
   DELIVERED — its worked span against `requiredHoursPerShift`/`halfDayHours` —
   never by when it began.

2. **Moving the shift-start anchor forward must never reduce a day's guaranteed
   paid hours.** This is the one invariant `resolveStartAnchor` (`shift-boundaries.ts:192-198`)
   states must survive any future change to the anchor logic. Both of its
   "Tier 1"/"Tier 2" branches cap at the same paid amount either way; only the
   *lateness label* and the *pending-OT remainder* move. Any v2 rewrite of this
   logic must re-derive and keep this invariant, not just match today's outputs.

3. **A closer sent home early must not lose a full hour to a truncation
   artifact.** `earlyOutGraceMinutes` exists specifically because the clock-out
   hour is floored: without grace, letting someone go 15 minutes before the hour
   costs them the WHOLE remaining 45+ minutes, not the 15 actually lost
   (`shift-boundaries.ts:104-113`). Default is 0 (off) so no existing store's pay
   silently moved when the feature shipped — a real "don't retroactively change
   pay by shipping a fix" discipline worth carrying into v2's rollout of anything
   similar.

4. **Grace/rounding constants are business decisions, not tuning knobs — list
   them all, verbatim, before any v2 payroll code is written:**
   - `lateGraceMinutes` (default 0), `earlyOutGraceMinutes` (default 0),
     `undertimeGraceMinutes` (default 0) — `attendance-config.ts:82,95,113,193-195`.
   - `requiredHoursPerShift` (default **9**), `halfDayHours` (default **5**),
     `shortShiftHalfDayOt` (default **false**, opt-in) — `attendance-config.ts:174,183,182`.
   - Night-differential window default **22:00–06:00** — `attendance-config.ts:178-179`.
   - `latePolicy` is a three-way switch — `record_only` (score only, no money),
     `charge_per_minute` (a real payslip deduction), `infraction` (points, no
     money) — **mutually exclusive by design**, per-store (`attendance-config.ts:73-78`).
     `lateChargePerMinute` and `lateInfractionPoints` are the two payload
     constants for the last two modes (`:80,115`).
   - SSS: EE rate **4.5%** of MSC, MSC floor **₱4,000** / ceiling **₱30,000**,
     rounded to the nearest ₱500 bracket (`statutory.ts:40-51`).
   - PhilHealth: EE rate **2.5%** (half the 5% premium), floor **₱10,000** /
     ceiling **₱100,000** (`statutory.ts:54-64`).
   - Pag-IBIG: **1%** at/under ₱1,500 monthly comp else **2%**, capped at
     **₱10,000** comp (max EE contribution **₱200**) (`statutory.ts:66-77`).
   - MAX_QUEUE_AGE for an offline punch: **72 hours** (`offline-replay.ts:7`,
     per `05-offline-and-biometrics.md §4`) — a hard ceiling on how long a device
     may stay offline before its oldest queued punches become permanently
     unsyncable.
   - Debounce **8 seconds** (live punches only; a replay is never debounced —
     dedupe there is the idempotency doc, not the time window) —
     `attendance-clock.actions.ts:27`, `05-offline-and-biometrics.md §4`.
   - Throttle: **10 misses in 60 seconds → 60-second lockout** on passcode and
     face — `attendance-clock.actions.ts:453-512`.
   - OT half-hour display rounding needs **25 minutes into a block** to round up
     — `ot-rounding.ts:10-14` (display-only; never changes what's actually filed).

5. **Segregation-of-duties has three DIFFERENT exemption shapes, not one
   generic rule** (`03-business-logic.md §2.9`, re-confirmed by direct reading here):
   cash-request approval blocks the requester with admin-only override; salary
   advance/repayment blocks the beneficiary but explicitly EXEMPTS `charge`
   (which only increases their own debt); overtime approval blocks the approver's
   own OT but explicitly leaves reject/void open (they only move pay DOWN). A v2
   "generic self-dealing guard" that doesn't preserve these per-case exemptions
   would either over-block (an admin can't charge their own advance up) or
   under-protect.

6. **A payslip must never disagree with what was actually recorded, even if
   today's config has since changed.** `payroll.actions.ts:15-18` states this
   directly: `computePayslip` reads the STORED `payrollComputedHours ??
   computedHours` rather than recomputing against live config, specifically so a
   payslip always reflects what was paid, not what today's rules would produce
   for the same historical day. This is a historical-integrity requirement, not
   an implementation shortcut — it must survive the SQL rewrite.

7. **Void order matters and is enforced, not just documented.** Voiding a
   per-staff payout while its period's lump-sum salaries expense is still posted
   would strand `liability__salaries_payable` non-zero with nothing able to clear
   it — the expense must be voided FIRST (`staff-payout.ts:142-167`). The mirror
   case (pay-after-expense-recorded) is guarded the same way
   (`staff-payout.ts:169-196`). Both refusals were added in "round 2/5" after
   being found as real bugs, not designed in from the start — a signal that a
   fresh v2 implementation could easily reintroduce the same hole if this
   ordering constraint isn't carried forward explicitly as a named invariant.

8. **A manager should not be prompted for a decision that can't change money.**
   `isStartDecisionMaterial` (`shift-boundaries.ts:447-507`) exists because,
   measured at one branch, 52% of ALL flagged sessions were already full shifts
   regardless of which start they were anchored to — asking anyway produced a
   wall of meaningless prompts. This is an operational-load finding, not a purely
   technical one, and should inform v2's UX even where the underlying computation
   changes.

9. **Auto-filed disciplinary records respect a manager's decision to turn them
   off, and never resurrect a voided one.** Every auto-infraction path
   (`operations/auto-infraction.ts`) checks the type's `isActive` before filing,
   and a previously-voided record is left voided even if the triggering condition
   recurs — "a manager voided it on purpose, and re-toggling ... must not
   quietly resurrect a penalty they cancelled" (`auto-infraction.ts:269-272`).

10. **A memo's frozen roster and an onboarding proposal's manager-edit path both
    exist to protect against the SAME failure mode from opposite directions.**
    Memo roster reconciliation stops a memo being stuck incomplete forever
    because someone left; the onboarding "propose edit" flow stops a manager
    directly overwriting admin-owned content. Both are worth preserving as
    distinct mechanisms rather than collapsing into one generic "staff roster
    changed" handler — they solve different problems (job continuity vs.
    content-ownership authority).
